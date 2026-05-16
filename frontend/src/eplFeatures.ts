export const PROJECT_TYPES = ["fixed_ground", "tracker", "floating", "agro_pv", "hybrid", "unknown"] as const;
export const CREATE_PROJECT_TYPES = ["fixed_ground", "floating", "tracker", "hybrid"] as const;

export const FEATURES = [
  "physical_rows",
  "string_zones",
  "strings",
  "optimizers",
  "modules",
  "inverters",
  "icb",
  "dccb",
  "bess",
  "pcs",
  "cable_trenches",
  "communication",
  "grounding",
  "trackers",
  "piers",
  "floating_assets",
  "security_devices",
  "cameras",
  "weather_station",
  "weather_sensors",
  "gps_capture",
] as const;

export type ProjectType = typeof PROJECT_TYPES[number];
export type CreateProjectType = typeof CREATE_PROJECT_TYPES[number];
export type FeatureState = "required" | "optional" | "disabled";
export type FeatureConfig = Record<string, FeatureState>;

export const FEATURE_LABELS: Record<string, string> = {
  physical_rows: "Physical rows",
  string_zones: "String zones",
  strings: "Strings",
  optimizers: "Optimizers",
  modules: "Modules",
  inverters: "Inverters",
  icb: "ICB",
  dccb: "DCCB",
  bess: "BESS",
  pcs: "PCS",
  cable_trenches: "Cable trenches",
  communication: "Communication",
  grounding: "Grounding",
  trackers: "Trackers",
  piers: "Piers",
  floating_assets: "Floating assets",
  security_devices: "Security devices",
  cameras: "Cameras",
  weather_station: "Weather station",
  weather_sensors: "Weather sensors",
  gps_capture: "GPS capture",
};

export const FEATURE_PRESETS: Record<ProjectType, Partial<FeatureConfig>> = {
  floating: {
    floating_assets: "required",
    strings: "required",
    inverters: "required",
    icb: "optional",
    bess: "optional",
    pcs: "optional",
    cable_trenches: "optional",
    communication: "optional",
    grounding: "optional",
    security_devices: "optional",
    cameras: "optional",
    weather_station: "optional",
    weather_sensors: "optional",
  },
  agro_pv: {
    physical_rows: "required",
    string_zones: "required",
    strings: "required",
    optimizers: "required",
    modules: "required",
    inverters: "required",
    icb: "optional",
    bess: "optional",
    pcs: "optional",
    cable_trenches: "optional",
    communication: "optional",
    grounding: "optional",
    security_devices: "optional",
    cameras: "optional",
    weather_station: "optional",
    weather_sensors: "optional",
  },
  tracker: {
    trackers: "required",
    piers: "required",
    strings: "required",
    inverters: "required",
    dccb: "optional",
    cable_trenches: "optional",
    grounding: "optional",
    weather_station: "optional",
    weather_sensors: "optional",
  },
  fixed_ground: {
    physical_rows: "required",
    strings: "required",
    modules: "required",
    inverters: "required",
    cable_trenches: "optional",
    grounding: "optional",
  },
  hybrid: {},
  unknown: {},
};

export function defaultFeatureState(projectType: string): FeatureConfig {
  const type = PROJECT_TYPES.includes(projectType as ProjectType) ? projectType as ProjectType : "unknown";
  const config = Object.fromEntries(FEATURES.map((feature) => [feature, "disabled"])) as FeatureConfig;
  return { ...config, ...FEATURE_PRESETS[type] };
}

export function featureLabel(feature: string): string {
  return FEATURE_LABELS[feature] || feature.replace(/_/g, " ");
}
