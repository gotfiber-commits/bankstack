// Banking-native vocabularies: core banking systems and licenses/certifications.
// The one source of truth for ids and labels; the front end mirrors the labels.
// No imports, so tests and match.mjs can load it without pulling in db/Stripe deps.

export const CORE_SYSTEMS = {
  "jack-henry-silverlake": "Jack Henry SilverLake",
  "jack-henry-cif2020": "Jack Henry CIF 20/20",
  "symitar-episys": "Symitar Episys",
  "fiserv-dna": "Fiserv DNA",
  "fiserv-premier": "Fiserv Premier",
  "fiserv-signature": "Fiserv Signature",
  "fis-horizon": "FIS Horizon",
  "fis-ibs": "FIS IBS",
  "corelation-keystone": "Corelation KeyStone",
  "csi-nupoint": "CSI NuPoint",
  "finastra-phoenix": "Finastra Phoenix",
  "temenos-transact": "Temenos Transact",
};

export const LICENSES = {
  "nmls": "NMLS (MLO)",
  "crcm": "CRCM",
  "cams": "CAMS",
  "cfe": "CFE",
  "ctfa": "CTFA",
  "cfa": "CFA",
  "cpa": "CPA",
  "aap": "AAP",
  "sie": "SIE",
  "series-6": "Series 6",
  "series-7": "Series 7",
  "series-63": "Series 63",
  "series-65": "Series 65/66",
};

export const CORE_SYSTEM_IDS = Object.keys(CORE_SYSTEMS);
export const LICENSE_IDS = Object.keys(LICENSES);

// Spot systems and licenses in résumé text. Word boundaries keep short ids like
// "sie" or "cfa" from matching inside ordinary words.
const DETECT = [
  ["jack-henry-silverlake", /silver\s?lake/i],
  ["jack-henry-cif2020", /cif\s?20\/?20/i],
  ["symitar-episys", /\b(episys|symitar)\b/i],
  ["fiserv-dna", /fiserv\s+dna|\bdna\b[^.]{0,20}(core|fiserv)|(core|fiserv)[^.]{0,20}\bdna\b/i],
  ["fiserv-premier", /fiserv[^.]{0,20}premier|premier[^.]{0,20}fiserv/i],
  ["fiserv-signature", /fiserv[^.]{0,20}signature|signature[^.]{0,20}fiserv/i],
  ["fis-horizon", /\bfis\b[^.]{0,20}horizon|horizon[^.]{0,20}\bfis\b/i],
  ["fis-ibs", /\bfis\b[^.]{0,20}\bibs\b|\bibs\b[^.]{0,20}\bfis\b/i],
  ["corelation-keystone", /corelation|\bkeystone\b[^.]{0,20}(core|corelation)/i],
  ["csi-nupoint", /nupoint|\bcsi\b[^.]{0,20}(core|nupoint)/i],
  ["finastra-phoenix", /finastra|phoenix[^.]{0,20}(core|efe)/i],
  ["temenos-transact", /temenos/i],
  ["nmls", /\bnmls\b/i],
  ["crcm", /\bcrcm\b/i],
  ["cams", /\bcams\b|certified anti-?money laundering/i],
  ["cfe", /\bcfe\b|certified fraud examiner/i],
  ["ctfa", /\bctfa\b/i],
  ["cfa", /\bcfa\b|chartered financial analyst/i],
  ["cpa", /\bcpa\b|certified public accountant/i],
  ["aap", /\baap\b|accredited ach professional/i],
  ["sie", /\bsie\b|securities industry essentials/i],
  ["series-6", /series\s?6\b/i],
  ["series-7", /series\s?7\b/i],
  ["series-63", /series\s?63\b/i],
  ["series-65", /series\s?6[56]\b/i],
];

// Returns { core_systems: [...], licenses: [...] } found in the text.
export function detectBankingBackground(text) {
  const t = String(text || "");
  const core_systems = [], licenses = [];
  if (!t) return { core_systems, licenses };
  for (const [id, re] of DETECT) {
    if (!re.test(t)) continue;
    (CORE_SYSTEMS[id] ? core_systems : licenses).push(id);
  }
  return { core_systems, licenses };
}

// Shared cleanup for the TEXT[] fields coming in from forms.
export const cleanCoreSystems = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => CORE_SYSTEMS[x]))] : []);
export const cleanLicenses = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => LICENSES[x]))] : []);
