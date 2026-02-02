import yaml from 'js-yaml';
import { LABEL_POS_X, LABEL_POS_Y } from './constants';

function normalizeInterface(iface: string | undefined): string | undefined {
  if (!iface) return undefined;
  const m = iface.match(/^e1-(\d+)$/i);
  if (m) return `ethernet-1-${m[1]}`;
  if (/^ethernet-1-\d+/i.test(iface) || /^eth\d+/i.test(iface)) return iface;
  return iface;
}

function shortInterfaceName(iface: string | undefined): string | undefined {
  if (!iface) return undefined;
  return iface.replace(/^ethernet-/i, 'e-');
}

function makeLinkName(localNode: string | undefined, remoteNode: string | undefined, index = 1, provided?: string) {
  if (provided) return provided;
  if (localNode && remoteNode) return `${localNode}-${remoteNode}-${index}`;
  return `link-${index}`;
}

export function containerlabToNetworkTopologyCrd(containerlabData: any, includeProduction = false): string {
  const metadataName = containerlabData.name || 'containerlab-topology';

  // Support both direct format (nodes/links at root) and wrapped format (topology.nodes/topology.links)
  const topology = containerlabData.topology || containerlabData;
  const nodesObj = topology.nodes || {};
  const linksArr = topology.links || [];

  const networkNodes = Object.keys(nodesObj).map((nodeName) => {
    const node = nodesObj[nodeName] || {};
    const labels = node.labels || {};
    const networkNode: any = { name: nodeName };
    if (node.kind) networkNode.platform = node.kind;
    // Don't set nodeProfile from node.type - it's only for platform detection
    if (Object.keys(labels).length) {
      // Filter out labels whose values look like file paths (contain '/')
      const filtered: Record<string, any> = {};
      Object.keys(labels).forEach((k) => {
        try {
          const v = labels[k];
          const sv = v === undefined || v === null ? '' : String(v);
          if (!sv.includes('/')) filtered[k] = v;
        } catch (e) {
          // if any error, skip this label
        }
      });
      networkNode.labels = filtered;
    }
    // Normalize containerlab label on the node itself: prefer managedsrl/managedsros/managedeos
    const img = (node.image || '').toString().toLowerCase();
    const kindLower = (node.kind || '').toString().toLowerCase();
    const labelsText = JSON.stringify(labels).toLowerCase();
    let nodeContainerlabLabel = 'managedsrl';
    if (img.includes('sros') || kindLower.includes('sros') || labelsText.includes('sros')) nodeContainerlabLabel = 'managedsros';
    else if (img.includes('eos') || kindLower.includes('arista') || labelsText.includes('eos')) nodeContainerlabLabel = 'managedeos';
    networkNode.labels = networkNode.labels || {};
    networkNode.labels['containerlab'] = nodeContainerlabLabel;
    // prefer a clearer platform if available in labels, type field, or image
    const rawClabType = (node.type || labels['clab-node-type'] || node.kind || '').toString().toLowerCase();
    const mapClabTypeToPlatform = (val: string | undefined) => {
      if (!val) return undefined;
      if (val.includes('ixrd1') || val.includes('ixr-d1') || val.includes('d1')) return '7220 IXR-D1';
      if (val.includes('ixrd3l') || val.includes('ixr-d3l') || val.includes('ixrd3') || val.includes('d3l')) return '7220 IXR-D3L';
      if (val.includes('ixrd5') || val.includes('ixr-d5') || val.includes('ixrd5') || val.includes('d5')) return '7220 IXR-D5';
      if (val.includes('ixr') && val.includes('d5')) return '7220 IXR-D5';
      return undefined;
    };
    const mappedPlatform = mapClabTypeToPlatform(rawClabType);
    networkNode.platform = mappedPlatform || node.kind || networkNode.platform;

    // derive role for this node so we can set sensible per-node platform defaults
    const derivedRole = (labels.role || labels.Role || node.group || labels['clab-node-group'] || '').toString().toLowerCase();
    if (!networkNode.platform) {
      if (derivedRole.includes('border') || derivedRole.includes('spine') || derivedRole.includes('superspine')) {
        networkNode.platform = '7220 IXR-D5';
      } else if (derivedRole.includes('leaf')) {
        networkNode.platform = '7220 IXR-D3L';
      }
    }

    // Always extract version from container image if present
    if (typeof node.image === 'string') {
      const m = node.image.match(/:(.+)$/);
      if (m) networkNode.version = m[1];
    }
    
    // Store version temporarily - we'll decide later if nodeProfile needs to be set
    // based on whether it differs from the template version

    if (includeProduction) {
      // production address
      // productionAddress should come from the node's management IPv4 address
      const ipv4 = node['mgmt-ipv4-address'] || node['mgmt-ipv4'] || labels['mgmt-ipv4-address'] || labels['clab-mgmt-net-bridge'] || undefined;
      if (ipv4) {
        networkNode.productionAddress = { ipv4 };
      }
      
      // Only include production metadata if we have production address or other production data
      networkNode.npp = { mode: 'normal' };
      networkNode.onBoarded = false;
      networkNode.operatingSystem = 'srl';
      // template: use role or labels to infer
      const role = (labels.role || labels.Role || '').toString().toLowerCase();
      networkNode.template = role.includes('leaf') ? 'leaf' : (role || undefined);
    }
    // Don't set nodeProfile here - we'll set it later only if the node's version
    // differs from its template's version
    return networkNode;
  });

  // detect a common version across nodes to use in nodeTemplates if present
  const detectedVersions = new Set(networkNodes.map((n: any) => n.version).filter(Boolean));
  const commonVersion = detectedVersions.size === 1 ? Array.from(detectedVersions)[0] : undefined;

  // --- POSITIONING: prefer explicit containerlab coordinates if available ---
  const findCoord = (n: any, keyCandidates: string[]) => {
    for (const k of keyCandidates) {
      if (n.labels && n.labels[k] !== undefined) return n.labels[k];
      if (n[k] !== undefined) return n[k];
    }
    return undefined;
  };

  const roleSource = (nodeObj: any) => {
    const labels = nodeObj.labels || {};
    return (labels.role || labels.Role || nodeObj.group || labels['clab-node-group'] || '').toString().toLowerCase();
  };

  const roleGroups = new Map<string, string[]>();
  Object.keys(nodesObj).forEach((nodeName) => {
    const r = roleSource(nodesObj[nodeName]) || 'other';
    if (!roleGroups.has(r)) roleGroups.set(r, []);
    roleGroups.get(r)!.push(nodeName);
  });

  // DC fabric preferred ordering (bottom -> top): mgmt -> leaf -> spine -> superspine -> borderleaf -> dcgw
  // This places management devices at the bottom, and borderleaf above spines/superspines.
  const preferredOrder = [
    'mgmt', 'management', // management nodes at the bottom
    'leaf', 'leafs',
    'spine', 'spines',
    'superspine', 'superspines',
    'borderleaf', 'border-leaf',
    'dcgw', 'gateway'
  ];
  const priority = (role: string) => {
    for (let i = 0; i < preferredOrder.length; i++) {
      if (role.includes(preferredOrder[i])) return i;
    }
    return preferredOrder.length;
  };

  const sortedRoles = [...roleGroups.keys()].sort((a, b) => {
    const pa = priority(a);
    const pb = priority(b);
    if (pa !== pb) return pa - pb;
    return a.localeCompare(b);
  });

  const hSpacing = 300;
  const vSpacing = 140;

  const nodeNameToIndex = new Map(networkNodes.map((n, i) => [n.name, i]));

  // Helper: choose containerlab label value based on node hints
  const chooseContainerlabLabelForMembers = (memberNames: string[]) => {
    const scores = { managedsrl: 0, managedsros: 0, managedeos: 0 };
    for (const nm of memberNames) {
      const src = nodesObj[nm] || {};
      const labels = src.labels || {};
      const image = (src.image || '').toString().toLowerCase();
      const kind = (src.kind || '').toString().toLowerCase();
      const combined = (image + ' ' + kind + ' ' + JSON.stringify(labels)).toLowerCase();
      if (combined.includes('srl') || combined.includes('srlinux') || combined.includes('nokia')) scores.managedsrl++;
      if (combined.includes('sros') || combined.includes('sros-') || combined.includes('sros:')) scores.managedsros++;
      if (combined.includes('eos') || combined.includes('arista') || combined.includes('eos:')) scores.managedeos++;
    }
    // choose highest score, default to managedsrl
    const max = Math.max(scores.managedsrl, scores.managedsros, scores.managedeos);
    if (max === scores.managedsros) return 'managedsros';
    if (max === scores.managedeos) return 'managedeos';
    return 'managedsrl';
  };

  // Helper: choose platform string (7220 IXR-D3L / 7220 IXR-D5) based on node hints
  const choosePlatformForMembers = (memberNames: string[]) => {
    let d1 = 0;
    let d3 = 0;
    let d5 = 0;
    for (const nm of memberNames) {
      const src = nodesObj[nm] || {};
      const labels = src.labels || {};
      const nodeType = (src.type || '').toString().toLowerCase();
      const image = (src.image || '').toString().toLowerCase();
      const kind = (src.kind || '').toString().toLowerCase();
      const clab = (labels['clab-node-type'] || '').toString().toLowerCase();
      const combined = (nodeType + ' ' + image + ' ' + kind + ' ' + clab).toLowerCase();
      if (combined.includes('ixrd1') || combined.includes('ixr-d1') || combined.includes('d1')) d1++;
      if (combined.includes('ixrd3l') || combined.includes('ixr-d3l') || combined.includes('d3l')) d3++;
      if (combined.includes('ixrd5') || combined.includes('ixr-d5') || combined.includes('d5')) d5++;
    }
    // choose the highest-scoring platform; prefer D3L as default
    if (d1 >= d3 && d1 >= d5 && d1 > 0) return '7220 IXR-D1';
    if (d5 >= d1 && d5 >= d3 && d5 > 0) return '7220 IXR-D5';
    if (d3 > 0) return '7220 IXR-D3L';
    return '7220 IXR-D3L';
  };

  Object.keys(nodesObj).forEach((nodeName) => {
    const node = nodesObj[nodeName] || {};
    const x = findCoord(node, ['graph-x', 'graph_x', 'x', 'pos-x', 'pos_x']);
    const y = findCoord(node, ['graph-y', 'graph_y', 'y', 'pos-y', 'pos_y']);
    if (x !== undefined || y !== undefined) {
      const idx = nodeNameToIndex.get(nodeName);
      if (idx === undefined) return;
      const target = networkNodes[idx];
      target.labels = target.labels || {};
      if (x !== undefined) target.labels[LABEL_POS_X] = String(x);
      if (y !== undefined) target.labels[LABEL_POS_Y] = String(y);
    }
  });

  // Place members centered per level left-to-right; role levels run bottom-to-top (so first role in sortedRoles is bottom)
  const maxLevel = Math.max(0, sortedRoles.length - 1);
  sortedRoles.forEach((role, levelIdx) => {
    const members = roleGroups.get(role) || [];
    const count = members.length;
    const startX = count > 0 ? -((count - 1) * hSpacing) / 2 : 0;
    members.forEach((nodeName, idx) => {
      const nodeIdx = nodeNameToIndex.get(nodeName);
      if (nodeIdx === undefined) return;
      const target = networkNodes[nodeIdx];
      target.labels = target.labels || {};
      if (target.labels[LABEL_POS_X] !== undefined || target.labels[LABEL_POS_Y] !== undefined) return;
      const x = startX + idx * hSpacing;
      // invert level so smallest levelIdx sits at bottom
      const y = (maxLevel - levelIdx) * vSpacing;
      target.labels[LABEL_POS_X] = String(x);
      target.labels[LABEL_POS_Y] = String(y);
    });
  });

  // Ensure no negative X positions: shift all X values so min X == 0
  try {
    const xs: number[] = networkNodes
      .map((n: any) => n.labels && n.labels[LABEL_POS_X] ? Number(n.labels[LABEL_POS_X]) : NaN)
      .filter((v) => !isNaN(v));
    if (xs.length > 0) {
      const minX = Math.min(...xs);
      if (minX < 0) {
        const shift = -minX;
        networkNodes.forEach((n: any) => {
          if (n.labels && n.labels[LABEL_POS_X] !== undefined) {
            const xv = Number(n.labels[LABEL_POS_X]);
            if (!isNaN(xv)) n.labels[LABEL_POS_X] = String(Math.round((xv + shift) * 100) / 100);
          }
        });
      }
    }
  } catch (e) {
    // fallback: do nothing on any error
  }

  const yamlLinks: any[] = [];

  linksArr.forEach((link: any, linkIdx: number) => {
    let eps = link.endpoints || {};
    
    // Handle both formats:
    // 1. Array format: ["node1:interface1", "node2:interface2"]
    // 2. Object format: { "0": { node: "node1", interface: "interface1" }, ... }
    let ordered: Array<{ node?: string; interface?: string; raw?: any }> = [];
    
    if (Array.isArray(eps)) {
      // Parse string format "node:interface"
      ordered = eps.map((ep: any) => {
        if (typeof ep === 'string') {
          const [node, iface] = ep.split(':');
          return { node: node?.trim(), interface: iface?.trim() };
        } else if (ep && typeof ep === 'object') {
          return { node: ep.node, interface: ep.interface, raw: ep };
        }
        return {};
      });
    } else {
      const keys = Object.keys(eps);
      ordered = keys.map(k => ({ node: eps[k]?.node, interface: eps[k]?.interface, raw: eps[k] }));
    }

    if (ordered.length === 0) return;

    if (ordered.length === 2) {
      const a = ordered[0];
      const b = ordered[1];

      const local = a.node ? { node: a.node, interface: normalizeInterface(a.interface) } : undefined;
      const remote = b.node ? { node: b.node, interface: normalizeInterface(b.interface) } : undefined;

      const endpoints: any[] = [];
      if (local && remote) {
        endpoints.push({ local, remote });
      } else {
        if (local) endpoints.push({ local });
        if (remote) endpoints.push({ local: remote });
      }

      // prefer detailed name: local-node-local-interface-remote-node-remote-interface
      let linkName = link.name;
      if (!linkName && local?.node && remote?.node) {
        if (local.interface && remote.interface) {
          const li = (shortInterfaceName(local.interface) || local.interface).replace(/\//g, '-');
          const ri = (shortInterfaceName(remote.interface) || remote.interface).replace(/\//g, '-');
          linkName = `${local.node}-${li}-${remote.node}-${ri}`;
        } else {
          linkName = makeLinkName(local?.node, remote?.node, linkIdx + 1, undefined);
        }
      }

      yamlLinks.push({
        name: linkName,
        labels: link.labels && Object.keys(link.labels).length ? link.labels : undefined,
        template: link.template || 'isl',
        endpoints,
      });
      return;
    }

    const endpoints: any[] = ordered.map((o) => (o.node ? { local: { node: o.node, interface: normalizeInterface(o.interface) } } : null)).filter(Boolean);
    yamlLinks.push({
        name: link.name || `esi-${linkIdx + 1}`,
        labels: link.labels && Object.keys(link.labels).length ? link.labels : undefined,
        template: link.template || undefined,
        endpoints,
    });
  });

  // Build nodeTemplates first, then check if individual nodes need nodeProfile override
  const nodeTemplatesArray = ((): any[] => {
    const roles = new Set<string>();
    Object.keys(nodesObj).forEach((n) => {
      const r = (nodesObj[n]?.labels?.role || nodesObj[n]?.labels?.Role || '').toString().toLowerCase() || '';
      if (r) roles.add(r);
    });
    const templates: any[] = [];
    roles.forEach((role) => {
      // Determine versions for this role from the discovered nodes
      const members = roleGroups.get(role) || [];
      const roleVersions = new Set<string>();
      members.forEach((nm) => {
        const idx = nodeNameToIndex.get(nm);
        if (idx !== undefined) {
          const v = (networkNodes[idx] as any).version;
          if (v) roleVersions.add(v);
        }
      });
      const roleVersion = roleVersions.size === 1 ? Array.from(roleVersions)[0] : commonVersion;

      const containerlabLabelForRole = chooseContainerlabLabelForMembers(members);
      const labelsObj: any = {
        containerlab: containerlabLabelForRole,
        'eda.nokia.com/role': role,
        'eda.nokia.com/security-profile': 'managed',
        'topobuilder.eda.labs/name-prefix': role,
      };
      const tpl: any = {
        labels: labelsObj,
        name: role,
        nodeProfile: roleVersion ? `srlinux-ghcr-${roleVersion}` : 'srlinux-ghcr-25.10.1',
      };
      // Prefer platform inferred from member nodes; fall back to role heuristics
      try {
        const inferredPlatform = choosePlatformForMembers(members || []);
        if (inferredPlatform) tpl.platform = inferredPlatform;
        else {
          if (role.includes('border') || role.includes('borderleaf')) tpl.platform = '7220 IXR-D5';
          else if (role.includes('superspine') || role.includes('superspines')) tpl.platform = '7220 IXR-D5';
          else if (role.includes('spine') || role.includes('spines')) tpl.platform = '7220 IXR-D5';
          else if (role.includes('leaf')) tpl.platform = '7220 IXR-D3L';
        }
      } catch (e) {
        if (role.includes('border') || role.includes('borderleaf')) tpl.platform = '7220 IXR-D5';
        else if (role.includes('superspine') || role.includes('superspines')) tpl.platform = '7220 IXR-D5';
        else if (role.includes('spine') || role.includes('spines')) tpl.platform = '7220 IXR-D5';
        else if (role.includes('leaf')) tpl.platform = '7220 IXR-D3L';
      }
      templates.push(tpl);
    });
    // If no roles detected, provide common defaults
    if (templates.length === 0) {
      const defaultLabel = chooseContainerlabLabelForMembers(Object.keys(nodesObj));
      // add a bootstrap `default` template at the top
      templates.unshift({
        labels: {
          containerlab: defaultLabel,
          'eda.nokia.com/bootstrap': 'true',
          'eda.nokia.com/security-profile': 'managed-bootstrap',
        },
        name: 'default',
        nodeProfile: commonVersion ? `srlinux-ghcr-${commonVersion}` : 'srlinux-ghcr-25.10.1',
        platform: '7220 IXR-D3L',
      });

      templates.push({
        labels: {
          containerlab: defaultLabel,
          'eda.nokia.com/role': 'leaf',
          'eda.nokia.com/security-profile': 'managed',
          'topobuilder.eda.labs/name-prefix': 'leaf',
        },
        name: 'leaf',
        nodeProfile: commonVersion ? `srlinux-ghcr-${commonVersion}` : 'srlinux-ghcr-25.10.1',
        platform: '7220 IXR-D3L',
      });
      templates.push({
        labels: {
          containerlab: defaultLabel,
          'eda.nokia.com/role': 'spine',
          'eda.nokia.com/security-profile': 'managed',
          'topobuilder.eda.labs/name-prefix': 'spine',
        },
        name: 'spine',
        nodeProfile: commonVersion ? `srlinux-ghcr-${commonVersion}` : 'srlinux-ghcr-25.10.1',
        platform: '7220 IXR-D5',
      });
    }
    return templates;
  })();

  // Now set nodeProfile on individual nodes only if their version differs from their template's version
  networkNodes.forEach((networkNode: any) => {
    if (!networkNode.version) return; // No version detected, skip
    
    // Find the template for this node based on role
    const nodeRole = (networkNode.labels?.role || networkNode.labels?.Role || '').toString().toLowerCase();
    const template = nodeTemplatesArray.find(t => t.name === nodeRole);
    
    if (template) {
      // Extract version from template's nodeProfile (format: srlinux-ghcr-VERSION)
      const templateProfileMatch = template.nodeProfile?.match(/srlinux-ghcr-(.+)$/);
      const templateVersion = templateProfileMatch ? templateProfileMatch[1] : null;
      
      // Only set nodeProfile if versions differ
      if (templateVersion && networkNode.version !== templateVersion) {
        networkNode.nodeProfile = `srlinux-ghcr-${networkNode.version}`;
      }
    } else if (networkNode.version) {
      // No matching template found, set nodeProfile based on node's version
      networkNode.nodeProfile = `srlinux-ghcr-${networkNode.version}`;
    }
  });

  const crd = {
    apiVersion: 'topologies.eda.nokia.com/v1alpha1',
    kind: 'NetworkTopology',
    metadata: { name: metadataName, namespace: 'eda' },
    spec: {
      operation: 'create',
      // Generate nodeTemplates from discovered roles (provide sensible defaults)
      nodeTemplates: nodeTemplatesArray,
      nodes: networkNodes,
      linkTemplates: [
        {
          name: 'isl',
          type: 'interSwitch',
          speed: '25G',
          encapType: 'null',
          labels: { 'eda.nokia.com/role': 'interSwitch' },
        },
        {
          name: 'edge',
          type: 'edge',
          encapType: 'dot1q',
          labels: { 'eda.nokia.com/role': 'edge' },
        },
      ],
      links: yamlLinks,
    },
  };

  const raw = yaml.dump(crd, { indent: 2, lineWidth: -1, noRefs: true, sortKeys: false });

  // Post-process YAML to ensure generated label values are double-quoted.
  // We only operate inside `labels:` blocks to avoid altering other scalars.
  const lines = raw.split('\n');
  const outLines: string[] = [];
  let inLabels = false;
  let labelsIndent = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    if (!inLabels) {
      outLines.push(line);
      if (/^labels:\s*$/.test(trimmed)) {
        inLabels = true;
        labelsIndent = indent;
      }
      continue;
    }

    // If we've left the labels block (indent <= labelsIndent), stop label mode
    if (trimmed === '' || indent <= labelsIndent) {
      inLabels = false;
      outLines.push(line);
      continue;
    }

    // We're inside labels block; match key: value
    const m = /^([\s]*)([^:]+):\s*(.*)$/.exec(line);
    if (m) {
      const pre = m[1];
      const key = m[2];
      let val = m[3] || '';
      const vtrim = val.trim();
      // Don't re-quote if already quoted or YAML literal/block indicator or null/boolean
      if (!(/^".*"$/.test(vtrim) || /^'.*'$/.test(vtrim) || vtrim === '|' || vtrim === '>' || /^(true|false|null|~)$/.test(vtrim))) {
        // Quote value; preserve any comment after value
        const commentIndex = val.indexOf('#');
        let comment = '';
        if (commentIndex !== -1) {
          comment = ' ' + val.substring(commentIndex).trimRight();
          val = val.substring(0, commentIndex).trimRight();
        }
        // If value is empty, keep as empty string
        const bare = val.trim();
        const quoted = `"${bare.replace(/"/g, '\\"')}"`;
        outLines.push(pre + key + ': ' + quoted + comment);
      } else {
        outLines.push(line);
      }
    } else {
      outLines.push(line);
    }
  }

  return outLines.join('\n');
}

export default containerlabToNetworkTopologyCrd;
