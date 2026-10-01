// Identifica marca, linea y formato fisico de un servidor a partir de lo que
// detecta el agente (fabricante, modelo, familia, tipo de chasis) o de lo que
// se cargo a mano. Con eso se elige la imagen del servidor.

export type FormFactor = 'rack1u' | 'rack2u' | 'rack4u' | 'tower' | 'blade' | 'vm' | 'desktop' | 'mini' | 'nas' | 'laptop';

export const FORM_FACTOR_LABEL: Record<FormFactor, string> = {
  rack1u: 'Rack 1U',
  rack2u: 'Rack 2U',
  rack4u: 'Rack 4U',
  tower: 'Torre',
  blade: 'Blade',
  vm: 'Máquina virtual',
  desktop: 'PC de escritorio',
  mini: 'Mini PC',
  nas: 'NAS',
  laptop: 'Notebook',
};

export type BrandKey = 'dell' | 'hpe' | 'hp' | 'lenovo' | 'supermicro' | 'fujitsu' | 'cisco' | 'vmware' | 'hyperv' | 'kvm' | 'synology' | 'qnap' | 'asus' | 'acer' | 'msi' | 'gigabyte' | 'intel' | 'generic';

export const BRANDS: Record<BrandKey, { label: string; accent: string; wordmark: string }> = {
  dell: { label: 'Dell', accent: '#0076CE', wordmark: 'DELL' },
  hpe: { label: 'HPE', accent: '#01A982', wordmark: 'HPE' },
  hp: { label: 'HP', accent: '#0096D6', wordmark: 'hp' },
  lenovo: { label: 'Lenovo', accent: '#E2231A', wordmark: 'Lenovo' },
  supermicro: { label: 'Supermicro', accent: '#1D5AA8', wordmark: 'SUPERMICRO' },
  fujitsu: { label: 'Fujitsu', accent: '#E60012', wordmark: 'FUJITSU' },
  cisco: { label: 'Cisco', accent: '#049FD9', wordmark: 'CISCO' },
  vmware: { label: 'VMware', accent: '#607078', wordmark: 'vmware' },
  hyperv: { label: 'Hyper-V', accent: '#00A4EF', wordmark: 'Hyper-V' },
  kvm: { label: 'KVM / Proxmox', accent: '#E57000', wordmark: 'KVM' },
  synology: { label: 'Synology', accent: '#4B4B4B', wordmark: 'Synology' },
  qnap: { label: 'QNAP', accent: '#0A5DA8', wordmark: 'QNAP' },
  asus: { label: 'ASUS', accent: '#00539B', wordmark: 'ASUS' },
  acer: { label: 'Acer', accent: '#83B81A', wordmark: 'acer' },
  msi: { label: 'MSI', accent: '#E1001A', wordmark: 'msi' },
  gigabyte: { label: 'Gigabyte', accent: '#F28C00', wordmark: 'GIGABYTE' },
  intel: { label: 'Intel', accent: '#0071C5', wordmark: 'intel' },
  generic: { label: 'Genérico', accent: '#64748B', wordmark: 'SERVER' },
};

function brandOf(text: string): BrandKey {
  const t = text.toLowerCase();
  if (/vmware/.test(t)) return 'vmware';
  if (/microsoft corporation|hyper-v|virtual machine/.test(t)) return 'hyperv';
  if (/qemu|kvm|proxmox|red hat|bochs|xen/.test(t)) return 'kvm';
  if (/dell|poweredge|optiplex|precision/.test(t)) return 'dell';
  if (/proliant|hpe|hewlett packard enterprise|synergy/.test(t)) return 'hpe';
  if (/\bhp\b|hewlett|prodesk|elitedesk|z\d+ workstation/.test(t)) return 'hp';
  if (/lenovo|thinksystem|thinkserver|thinkcentre|thinkstation|thinkpad/.test(t)) return 'lenovo';
  if (/supermicro|super micro|superserver/.test(t)) return 'supermicro';
  if (/fujitsu|primergy/.test(t)) return 'fujitsu';
  if (/cisco|ucs/.test(t)) return 'cisco';
  if (/synology|diskstation|rackstation/.test(t)) return 'synology';
  if (/qnap/.test(t)) return 'qnap';
  if (/asus/.test(t)) return 'asus';
  if (/acer/.test(t)) return 'acer';
  if (/micro-star|\bmsi\b/.test(t)) return 'msi';
  if (/gigabyte|giga-byte/.test(t)) return 'gigabyte';
  if (/intel corporation|\bnuc\b/.test(t)) return 'intel';
  return 'generic';
}

function formFactorOf(brand: BrandKey, model: string, chassisCode: number | null | undefined, virtual: boolean): FormFactor {
  const m = model.toLowerCase();
  if (virtual || brand === 'vmware' || brand === 'hyperv' || brand === 'kvm') return 'vm';
  if (brand === 'synology' || brand === 'qnap') return 'nas';
  // Dell PowerEdge: R6xx/R4xx/R3xx/R2xx = 1U, R5xx/R7xx/R8xx = 2U, R9xx = 4U, T = torre, M/MX/FC = blade.
  let r = /poweredge\s*r(\d)\d{1,2}/.exec(m);
  if (r) return ['5', '7', '8'].includes(r[1]) ? 'rack2u' : r[1] === '9' ? 'rack4u' : 'rack1u';
  if (/poweredge\s*t\d/.test(m)) return 'tower';
  if (/poweredge\s*(m|mx|fc)\d/.test(m)) return 'blade';
  // HPE ProLiant.
  r = /\bdl(\d+)/.exec(m);
  if (r) {
    const n = Number(r[1]);
    if ([20, 120, 160, 320, 325, 360, 365].includes(n)) return 'rack1u';
    if (n >= 580) return 'rack4u';
    return 'rack2u';
  }
  if (/\bml\d+/.test(m)) return 'tower';
  if (/\bbl\d+|synergy/.test(m)) return 'blade';
  if (/microserver/.test(m)) return 'mini';
  // Lenovo ThinkSystem / ThinkServer.
  // Lenovo ThinkSystem SR: SR950/SR860 = 4U; SR550/SR590/SR650/SR665/SR850 = 2U; SR250/SR530/SR570/SR630/SR645 = 1U.
  r = /\bsr(\d)(\d)\d/.exec(m);
  if (r) {
    if (r[1] === '9' || `${r[1]}${r[2]}` === '86') return 'rack4u';
    return ['5', '6', '9'].includes(r[2]) ? 'rack2u' : 'rack1u';
  }
  if (/\bst\d{3}|\btd\d{3}|thinkserver ts/.test(m)) return 'tower';
  if (/\bse\d{3}|\btiny\b|\bmicro\b|\bnuc\b|mini/.test(m)) return 'mini';
  // Supermicro SYS-1xxx = 1U, 2xxx = 2U, 4xxx/6xxx = 4U, 5xxx/7xxx = torre.
  r = /sys-(\d)/.exec(m);
  if (r) return r[1] === '1' ? 'rack1u' : r[1] === '2' ? 'rack2u' : ['5', '7'].includes(r[1]) ? 'tower' : 'rack4u';
  // Fujitsu PRIMERGY RX (rack) / TX (torre); Cisco UCS C220 / C240 / B.
  if (/primergy\s*rx\s*25|rx2540|rx4770/.test(m)) return 'rack2u';
  if (/primergy\s*rx/.test(m)) return 'rack1u';
  if (/primergy\s*tx/.test(m)) return 'tower';
  if (/c220/.test(m)) return 'rack1u';
  if (/c240/.test(m)) return 'rack2u';
  if (/ucs\s*b/.test(m)) return 'blade';
  if (/optiplex|prodesk|elitedesk|thinkcentre|vostro|veriton|expertcenter/.test(m)) return /micro|tiny|mini|mff|dm\b/.test(m) ? 'mini' : 'desktop';
  // Por el tipo de chasis que informa el BIOS.
  if (chassisCode === 23 || chassisCode === 17) return 'rack2u';
  if (chassisCode === 28) return 'blade';
  if (chassisCode === 35 || chassisCode === 36 || chassisCode === 34) return 'mini';
  if (chassisCode && [8, 9, 10, 14, 31].includes(chassisCode)) return 'laptop';
  if (chassisCode && [3, 4, 15, 13].includes(chassisCode)) return 'desktop';
  if (chassisCode && [6, 7].includes(chassisCode)) return 'tower';
  return 'tower';
}

export type ServerHardware = {
  manufacturer?: string | null;
  model?: string | null;
  family?: string | null;
  serial?: string | null;
  assetTag?: string | null;
  biosVersion?: string | null;
  biosDate?: string | null;
  chassis?: string | null;
  chassisCode?: number | null;
  cpu?: string | null;
  cpuCount?: number | null;
  cores?: number | null;
  threads?: number | null;
  cpuMhz?: number | null;
  ramBytes?: number | null;
  memoryModules?: { sizeBytes: number | null; speedMhz: number | null; maker: string | null; part: string | null }[];
  disks?: { model: string | null; sizeBytes: number | null; interface: string | null }[];
  nics?: { name: string; mac: string | null; speedMbps: number | null }[];
  os?: string | null;
  osVersion?: string | null;
  osBuild?: string | null;
  osInstalledAt?: string | null;
  osArch?: string | null;
  virtual?: boolean;
  domain?: string | null;
  sockets?: number | null;
};

/** Lo que devuelve GET /api/assets por servidor. */
export type AssetServer = {
  id: string;
  name: string;
  hostname: string | null;
  ipAddress: string | null;
  status: 'ONLINE' | 'OFFLINE' | 'DEGRADED';
  lastSeenAt: string | null;
  agentVersion: string | null;
  tags: string[];
  createdAt: string;
  hardware: ServerHardware | null;
  hardwareAt: string | null;
  uptimeSeconds: number | null;
  lastBootAt: string | null;
  volumes: { mount: string; fs: string; totalBytes: number; freeBytes: number; percent: number }[];
  physicalDisks: { name: string; mediaType: string; health: string; sizeBytes: number | null; predictFailure: boolean }[];
  cpuUsage: number | null;
  memoryUsage: number | null;
  diskUsage: number | null;
  asset: ServerAssetInfo;
  photoAt: string | null;
};

export type ServerAssetInfo = Partial<{
  brand: string;
  model: string;
  serial: string;
  assetTag: string;
  formFactor: FormFactor;
  cpu: string;
  ramGb: number;
  storage: string;
  raid: string;
  psu: string;
  os: string;
  role: string;
  location: string;
  rack: string;
  purchaseDate: string;
  warrantyUntil: string;
  supplier: string;
  supportContact: string;
  notes: string;
}>;

export type ServerProfile = {
  brandKey: BrandKey;
  brandLabel: string;
  accent: string;
  wordmark: string;
  model: string;
  formFactor: FormFactor;
  virtual: boolean;
};

function cleanModel(brand: BrandKey, hw: ServerHardware | null): string {
  if (!hw) return '';
  // Lenovo informa el "machine type" (7X06CTO1WW) en Model y el nombre real en SystemFamily.
  if (brand === 'lenovo' && hw.family && !/^to be filled/i.test(hw.family)) return hw.family;
  return [hw.model, /^(to be filled|default string|system product name)/i.test(hw.model ?? '') ? hw.family : null].filter(Boolean)[0] ?? '';
}

export function detectProfile(hw: ServerHardware | null, asset: ServerAssetInfo): ServerProfile {
  const brandText = `${asset.brand ?? ''} ${asset.model ?? ''} ${hw?.manufacturer ?? ''} ${hw?.model ?? ''} ${hw?.family ?? ''}`;
  const brandKey = brandOf(asset.brand ? `${asset.brand} ${asset.model ?? ''}` : brandText);
  const model = asset.model || cleanModel(brandKey, hw) || '';
  const virtual = Boolean(hw?.virtual) || ['vmware', 'hyperv', 'kvm'].includes(brandKey);
  const formFactor = asset.formFactor ?? formFactorOf(brandKey, `${model} ${hw?.family ?? ''}`, hw?.chassisCode, virtual);
  const b = BRANDS[brandKey];
  return { brandKey, brandLabel: asset.brand || (brandKey === 'generic' ? hw?.manufacturer || 'Sin identificar' : b.label), accent: b.accent, wordmark: b.wordmark, model, formFactor, virtual };
}

export function gib(bytes: number | null | undefined) {
  return bytes ? Math.round(bytes / 1024 ** 3) : null;
}

export function fmtBytes(bytes: number | null | undefined) {
  if (!bytes) return '—';
  const tb = bytes / 1000 ** 4;
  if (tb >= 1) return `${tb.toFixed(tb >= 10 ? 0 : 1)} TB`;
  return `${Math.round(bytes / 1000 ** 3)} GB`;
}

export function warrantyState(until: string | null | undefined): { label: string; tone: 'ok' | 'warn' | 'bad' | 'none'; days: number | null } {
  if (!until) return { label: 'Sin garantía cargada', tone: 'none', days: null };
  const days = Math.floor((new Date(`${until}T23:59:59`).getTime() - Date.now()) / 86400000);
  if (days < 0) return { label: `Garantía vencida hace ${-days} d`, tone: 'bad', days };
  if (days <= 90) return { label: `Garantía vence en ${days} d`, tone: 'warn', days };
  return { label: `Garantía hasta ${new Date(`${until}T12:00:00`).toLocaleDateString('es-AR')}`, tone: 'ok', days };
}

/** "Intel(R) Xeon(R) Silver 4214R CPU @ 2.40GHz" -> "Intel Xeon Silver 4214R". */
export function shortCpu(name: string | null | undefined) {
  if (!name) return null;
  return name
    .replace(/\((R|TM|tm|r)\)/g, '')
    .replace(/\bCPU\b|\bProcessor\b|@.*$|\d+-Core/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export type Spec = { value: string | null; source: 'manual' | 'agente' | null };

function pick(manual: string | number | null | undefined, detected: string | number | null | undefined, fmt: (v: string | number) => string = String): Spec {
  if (manual !== null && manual !== undefined && manual !== '') return { value: fmt(manual), source: 'manual' };
  if (detected !== null && detected !== undefined && detected !== '') return { value: fmt(detected), source: 'agente' };
  return { value: null, source: null };
}

/** Ficha resuelta: lo cargado a mano gana sobre lo detectado por el agente. */
export function resolveSpecs(s: AssetServer) {
  const hw = s.hardware ?? {};
  const a = s.asset ?? {};
  const profile = detectProfile(s.hardware, a);
  const modulesBytes = (hw.memoryModules ?? []).reduce((acc, m) => acc + (m.sizeBytes ?? 0), 0);
  const ramGbDetected = modulesBytes ? Math.round(modulesBytes / 1024 ** 3) : gib(hw.ramBytes);
  const disks = s.physicalDisks.length ? s.physicalDisks : (hw.disks ?? []).map((d) => ({ name: d.model ?? 'Disco', sizeBytes: d.sizeBytes }));
  const diskTotal = disks.reduce((acc, d) => acc + (d.sizeBytes ?? 0), 0);
  const cpuDetected = hw.cpu
    ? `${hw.cpuCount && hw.cpuCount > 1 ? `${hw.cpuCount}× ` : ''}${shortCpu(hw.cpu)}${hw.cores ? ` · ${hw.cores} núcleos / ${hw.threads ?? hw.cores} hilos` : ''}`
    : null;
  return {
    profile,
    brand: pick(a.brand, profile.brandKey === 'generic' ? hw.manufacturer : profile.brandLabel),
    model: pick(a.model, profile.model || hw.model),
    serial: pick(a.serial, hw.serial),
    assetTag: pick(a.assetTag, hw.assetTag),
    formFactor: { value: FORM_FACTOR_LABEL[profile.formFactor], source: a.formFactor ? 'manual' : 'agente' } as Spec,
    cpu: pick(a.cpu, cpuDetected),
    ram: pick(a.ramGb, ramGbDetected, (v) => `${v} GB`),
    storage: pick(a.storage, diskTotal ? `${fmtBytes(diskTotal)} en ${disks.length} disco${disks.length === 1 ? '' : 's'}` : null),
    os: pick(a.os, hw.os ? `${hw.os.replace(/^Microsoft /, '')}${hw.osBuild ? ` (build ${hw.osBuild})` : ''}` : null),
    bios: pick(null, hw.biosVersion ? `${hw.biosVersion}${hw.biosDate ? ` · ${new Date(hw.biosDate).toLocaleDateString('es-AR')}` : ''}` : null),
    raid: pick(a.raid, null),
    psu: pick(a.psu, null),
    role: pick(a.role, null),
    location: pick([a.location, a.rack ? `rack ${a.rack}` : null].filter(Boolean).join(' · ') || null, null),
    supplier: pick(a.supplier, null),
    supportContact: pick(a.supportContact, null),
    purchaseDate: pick(a.purchaseDate, null, (v) => new Date(`${v}T12:00:00`).toLocaleDateString('es-AR')),
    warranty: warrantyState(a.warrantyUntil),
    ramGbDetected,
    cpuShort: shortCpu(a.cpu || hw.cpu),
    coresLabel: hw.cores ? `${hw.cores}C/${hw.threads ?? hw.cores}T` : null,
    diskTotal,
  };
}

/** Que tan completa esta la ficha (lo detectado por el agente cuenta). */
export function completeness(s: AssetServer) {
  const r = resolveSpecs(s);
  const checks: [string, boolean][] = [
    ['Marca', Boolean(s.asset.brand) || (Boolean(r.brand.value) && r.profile.brandKey !== 'generic')],
    ['Modelo', Boolean(r.model.value)],
    ['N° de serie', Boolean(r.serial.value)],
    ['Función / rol', Boolean(s.asset.role)],
    ['Ubicación', Boolean(s.asset.location)],
    ['Fecha de compra', Boolean(s.asset.purchaseDate)],
    ['Garantía', Boolean(s.asset.warrantyUntil)],
    ['Proveedor', Boolean(s.asset.supplier)],
  ];
  const missing = checks.filter(([, ok]) => !ok).map(([k]) => k);
  return { pct: Math.round(((checks.length - missing.length) / checks.length) * 100), missing };
}
