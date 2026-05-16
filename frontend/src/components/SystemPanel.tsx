import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  updatePlantInfo,
  createProject,
  listProjectFiles,
  uploadProjectFile,
  clearProjectFiles,
  parseProject,
} from "../api";
import { useResponsive } from "../hooks/useResponsive";
import { useOnlineStatus } from "../hooks/useOnlineStatus";
import { BusyOverlay, ConfirmModal } from "./Modals";
import { CREATE_PROJECT_TYPES, defaultFeatureState, type CreateProjectType } from "../eplFeatures";

interface Props {
  projectId: string;
  onProjectChanged?: (projectId: string) => void;
  /** Render only a specific section: "files" (upload/parse) or "info" (metadata/validation). */
  section?: "files" | "info";
  /** Project summary — passed from App.tsx so we don't re-fetch. */
  project?: any;
  /** Plant info — passed from App.tsx so we don't re-fetch. */
  plantInfo?: any;
  /** Derived row/zone/string counts from the current parsed model. */
  assetSummary?: any;
  /** Called after plant info is updated so App can refresh its own state. */
  onPlantInfoChanged?: (info: any) => void;
}

type UploadKind = "construction_pdf" | "ramming_pdf" | "overlay_image" | "block_mapping" | "other";

const FILE_ACCEPT = ".pdf,.zip,.png,.jpg,.jpeg,.csv,.xlsx,.xls,.dxf,.dwg";

const FILE_KIND_LABELS: Record<string, string> = {
  construction_pdf: "Construction PDF",
  ramming_pdf: "Ramming PDF",
  overlay_image: "Overlay / color map",
  block_mapping: "Block mapping",
  other: "Supporting plan",
};

function guessUploadKind(file: File): UploadKind {
  const name = file.name.toLowerCase();
  const isImage = /\.(png|jpe?g)$/i.test(file.name);
  if (name.includes("block_names") || /block[\s_-]*(mapping|names?|zones?)/.test(name)) return "block_mapping";
  if (name.includes("ramming") || name.includes("pile plan") || name.includes("pier plan")) return "ramming_pdf";
  if (name.includes("color map") || name.includes("colour map") || name.includes("overlay")) return "overlay_image";
  if (name.includes("construction") || /agro[\s_-]*pv/.test(name) || name.includes("agro-pv")) return "construction_pdf";
  if (isImage && name.includes("block")) return "block_mapping";
  return "other";
}

export default function SystemPanel({ projectId, onProjectChanged, section, project: projectProp, plantInfo: plantInfoProp, assetSummary, onPlantInfoChanged }: Props) {
  const { t } = useTranslation();
  const { isMobile, isTablet } = useResponsive();
  const compact = isMobile || isTablet;
  const { online } = useOnlineStatus();
  const [error, setError] = useState("");
  // Project + plantInfo are owned exclusively by App.tsx now — we
  // read them from props and never re-fetch. Used to fetch them
  // ourselves as a "legacy" fallback, but that meant /api/projects/:id
  // and /api/projects/:id/plant-info each fired 3 times on a fresh
  // load (App + 2 SystemPanel instances), causing the visible blink
  // as state arrived in waves.
  const project = projectProp ?? null;
  const plantInfo = plantInfoProp ?? null;
  const [editingPlant, setEditingPlant] = useState(false);
  const [plantDraft, setPlantDraft] = useState<any>({});
  const [files, setFiles] = useState<any[]>([]);
  const [parsing, setParsing] = useState(false);
  const [parseMsg, setParseMsg] = useState("");
  const [showNewProject, setShowNewProject] = useState(false);
  const [newProjectId, setNewProjectId] = useState("");
  const [newProjectType, setNewProjectType] = useState<CreateProjectType>("fixed_ground");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<
    | null
    | { title: string; message: string; confirmLabel: string; danger?: boolean; action: () => void }
  >(null);
  const projectStringSummary = (project?.strings_optimizers || {}).summary || {};
  const projectStringMetadata = (project?.strings_optimizers || {}).metadata || {};
  const zoneCount = firstDefined(assetSummary?.zones, project?.zone_count, projectStringSummary.string_zones);
  const physicalRowCount = firstDefined(
    assetSummary?.physicalRows,
    project?.physical_row_count,
    project?.row_count,
    projectStringSummary.physical_rows,
  );
  const rowsWithWork = firstDefined(assetSummary?.rowsWithWork, projectStringSummary.rows_with_work);
  const stringCount = firstDefined(assetSummary?.strings, plantInfo?.total_strings, projectStringSummary.strings);
  const optimizerCount = firstDefined(
    assetSummary?.optimizers,
    projectStringSummary.optimizers,
    projectStringMetadata.expected_optimizers,
  );
  const panelCount = firstDefined(assetSummary?.panels, plantInfo?.total_modules, projectStringSummary.modules);
  const modulesPerString = firstDefined(
    assetSummary?.modulesPerString,
    plantInfo?.modules_per_string,
    projectStringMetadata.modules_per_string,
  );
  const optimizersPerString = firstDefined(assetSummary?.optimizersPerString, projectStringMetadata.optimizers_per_string);
  const trackerRowCount = Number(project?.tracker_count || 0) > 0 ? project?.row_count : undefined;
  const isElectricalProject = Boolean(
    project?.parse_scope === "electrical_only"
    || project?.document_profile === "agro_pv_epl"
    || projectStringSummary.strings
    || projectStringMetadata.expected_optimizers
  );

  // Only fetch files (lightweight); project + plantInfo come from props.
  async function refreshFiles() {
    if (!projectId) return;
    try {
      const fl = await listProjectFiles(projectId).catch(() => []);
      setFiles(fl);
    } catch (e: any) {
      setError(String(e.message || e));
    }
  }

  // Only the "files" section actually shows the file list — the
  // "info" section just renders project/plantInfo from props.  Skip
  // the listProjectFiles call entirely when we're rendering the
  // info section so two mounted SystemPanels don't both hit
  // /api/files (one would dedupe on jDeduped if concurrent, but in
  // practice the two effects fire moments apart and the dedupe map
  // has already cleared, producing two real HTTP requests).
  useEffect(() => {
    setError("");
    setParseMsg("");
    setFiles([]);
    setEditingPlant(false);
    if (projectId && section === "files") {
      refreshFiles();
    }
  }, [projectId, section]);

  async function handleCreateProject() {
    const id = newProjectId.trim();
    if (!id) return;
    try {
      await createProject({ project_id: id, project_type: newProjectType, enabled_features: defaultFeatureState(newProjectType) });
      setShowNewProject(false);
      setNewProjectId("");
      setNewProjectType("fixed_ground");
      onProjectChanged?.(id);
    } catch (e: any) {
      setError(String(e.message || e));
    }
  }

  async function uploadFiles(items: Array<{ kind: UploadKind; file: File }>) {
    if (!projectId || items.length === 0) return;
    try {
      setError("");
      setParseMsg("");
      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        const prefix = items.length > 1 ? `${i + 1}/${items.length}: ` : "";
        setBusy(`Uploading ${prefix}${item.file.name}...`);
        await uploadProjectFile(projectId, item.kind, item.file);
      }
      setBusy("Refreshing file list...");
      const fl = await listProjectFiles(projectId);
      setFiles(fl);
      setParseMsg(`Uploaded ${items.length} file${items.length === 1 ? "" : "s"}`);
      setTimeout(() => setParseMsg(""), 2000);
    } catch (e: any) {
      setError(String(e.message || e));
    } finally {
      setBusy(null);
    }
  }

  async function handleFileUpload(kind: UploadKind, file: File) {
    if (!file) return;
    await uploadFiles([{ kind, file }]);
  }

  async function handleBatchUpload(selectedFiles: File[]) {
    const items = selectedFiles.map((file) => ({ kind: guessUploadKind(file), file }));
    await uploadFiles(items);
  }

  function handleClearFiles() {
    if (!projectId) return;
    setConfirmState({
      title: "Delete uploaded files?",
      message: "Delete all uploaded files for this project?\n(Parsed data will not be affected until you re-parse.)",
      confirmLabel: "Delete",
      danger: true,
      action: async () => {
        setConfirmState(null);
        try {
          setBusy("Clearing files…");
          await clearProjectFiles(projectId);
          setFiles([]);
        } catch (e: any) {
          setError(String(e.message || e));
        } finally {
          setBusy(null);
        }
      },
    });
  }

  function handleParse() {
    if (!projectId) return;
    const message = isElectricalProject
      ? "Parse will refresh the electrical model from uploaded electrical documents. Continue?"
      : hasRammingPdf
      ? "Parse will clear all existing project data and rebuild from uploaded files. Continue?"
      : "No ramming PDF is uploaded. Parse will check the electrical/EPL documents only; upload the ramming PDF later to build blocks, trackers, and piers. Continue?";
    setConfirmState({
      title: "Parse project?",
      message,
      confirmLabel: "Parse",
      danger: true,
      action: async () => {
        setConfirmState(null);
        try {
          setParsing(true);
          setBusy("Parsing… this may take a minute or two");
          const result = await parseProject(projectId);
          if (result.parse_scope === "electrical_only") {
            setParseMsg(`Electrical check: ${Number(result.string_count || 0).toLocaleString()} strings, ${Number(result.optimizer_count || 0).toLocaleString()} optimizers.`);
          } else {
            setParseMsg(`Parsed: ${result.block_count} blocks, ${result.tracker_count} trackers, ${result.pier_count} piers`);
          }
          await refreshFiles();
          // App.tsx owns project + plantInfo; ask it to re-fetch.
          onProjectChanged?.(projectId);
        } catch (e: any) {
          setError(String(e.message || e));
          setParseMsg("");
        } finally {
          setParsing(false);
          setBusy(null);
        }
      },
    });
  }

  async function handlePlantSave() {
    if (!projectId) return;
    try {
      const toSave = { ...plantDraft };
      if (toSave.tolerance_ratio != null && toSave.tolerance_ratio !== "") {
        const n = parseFloat(toSave.tolerance_ratio);
        toSave.tolerance_ratio = isNaN(n) ? 0.05 : n;
      }
      const updated = await updatePlantInfo(projectId, toSave);
      // App.tsx owns plantInfo state via the onPlantInfoChanged
      // callback — no need to mirror it locally.
      onPlantInfoChanged?.(updated);
      setEditingPlant(false);
    } catch (e: any) {
      setError(String(e.message || e));
    }
  }

  const hasConstructionPdf = files.some((f) => f.kind === "construction_pdf");
  const hasRammingPdf = files.some((f) => f.kind === "ramming_pdf");
  const hasAnyFile = files.length > 0;
  const parseDisabled = parsing || !online || (isElectricalProject ? !hasAnyFile : !hasConstructionPdf);

  return (
    <div style={{ display: "grid", gap: 14 }}>
      {/* Offline warning banner */}
      {!online && (
        <div
          style={{
            border: "1px solid #fecaca",
            background: "#fef2f2",
            color: "#991b1b",
            padding: "8px 12px",
            borderRadius: 10,
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          You are offline. Uploading files, parsing, and creating projects are disabled.
          Pier status changes will keep working and sync automatically once you are back online.
        </div>
      )}

      {/* New Project + Files — shown when section is "files" or unset */}
      {(section === "files" || !section) && (<>
      {/* New Project + Files */}
      <div style={{ border: "1px solid #e2e8f0", borderRadius: 16, padding: compact ? 12 : 16, background: "#fff" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
          <div style={{ fontWeight: 800, fontSize: 16 }}>{t("sp.projectFiles")}</div>
          <button
            onClick={() => setShowNewProject(true)}
            disabled={!online}
            title={online ? "" : "Creating a project requires an internet connection"}
            style={{
              fontSize: 12,
              padding: "6px 12px",
              borderRadius: 6,
              border: "1px solid #d1d5db",
              background: online ? "#fff" : "#f1f5f9",
              cursor: online ? "pointer" : "not-allowed",
              opacity: online ? 1 : 0.6,
            }}
          >
            {t("sp.newProject")}
          </button>
        </div>
        {showNewProject && (
          <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap" }}>
            <input
              value={newProjectId}
              onChange={(e) => setNewProjectId(e.target.value)}
              placeholder={t("project.enterId")}
              style={{ flex: 1, minWidth: 180, padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13 }}
            />
            <select
              value={newProjectType}
              required
              onChange={(e) => setNewProjectType(e.target.value as CreateProjectType)}
              style={{ minWidth: 150, padding: "6px 10px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13, background: "#fff" }}
            >
              {CREATE_PROJECT_TYPES.map((type) => <option key={type} value={type}>{type.replace(/_/g, " ")}</option>)}
            </select>
            <button onClick={handleCreateProject} style={{ fontSize: 12, padding: "6px 14px", borderRadius: 6, border: "none", background: "#0f172a", color: "#fff", cursor: "pointer" }}>{t("app.create")}</button>
            <button onClick={() => { setShowNewProject(false); setNewProjectId(""); setNewProjectType("fixed_ground"); }} style={{ fontSize: 12, padding: "6px 14px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer" }}>{t("app.cancel")}</button>
          </div>
        )}
        {projectId ? (
          <>
            {isElectricalProject ? (
              <ElectricalReadinessCheck
                strings={stringCount}
                inverters={plantInfo?.inverters}
                dccb={plantInfo?.dccb}
                fileCount={files.length}
              />
            ) : (
              <FileReadinessCheck files={files} />
            )}
            <BatchUploadField onUpload={handleBatchUpload} disabled={!online} />
            {!isElectricalProject && (
              <div style={{ display: "grid", gridTemplateColumns: compact ? "1fr" : "repeat(3, minmax(0, 1fr))", gap: 10, marginBottom: 10 }}>
                <FileUploadField label="Construction PDF" kind="construction_pdf" files={files} onUpload={handleFileUpload} disabled={!online} />
                <FileUploadField label="Ramming PDF" kind="ramming_pdf" files={files} onUpload={handleFileUpload} disabled={!online} />
                <FileUploadField label="Block Mapping" kind="block_mapping" files={files} onUpload={handleFileUpload} disabled={!online} />
              </div>
            )}
            <UploadedFilesList files={files} />
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button
                onClick={handleParse}
                disabled={parseDisabled}
                title={!online ? "Parsing requires an internet connection" : parseDisabled ? (isElectricalProject ? "Upload at least one electrical document first" : "Upload a construction PDF first") : ""}
                style={{
                  fontSize: 13, padding: "8px 16px", borderRadius: 6, border: "none",
                  background: parseDisabled ? "#cbd5e1" : "#0f172a",
                  color: "#fff", fontWeight: 600,
                  cursor: parseDisabled ? "not-allowed" : "pointer",
                }}
              >
                {parsing ? t("sp.parsing") : t("sp.parse")}
              </button>
              {!isElectricalProject && !hasRammingPdf && hasConstructionPdf && (
                <span style={{ fontSize: 12, color: "#b45309", fontWeight: 600 }}>
                  Ramming PDF may be required after site detection.
                </span>
              )}
              {files.length > 0 && (
                <button
                  onClick={handleClearFiles}
                  disabled={!online}
                  title={online ? "" : "Clearing files requires an internet connection"}
                  style={{
                    fontSize: 12,
                    padding: "6px 10px",
                    borderRadius: 6,
                    border: "1px solid #d1d5db",
                    background: online ? "#fff" : "#f1f5f9",
                    cursor: online ? "pointer" : "not-allowed",
                    opacity: online ? 1 : 0.6,
                  }}
                >
                  {t("sp.clearFiles")}
                </button>
              )}
              {parseMsg && <span style={{ fontSize: 12, color: "#475569" }}>{parseMsg}</span>}
            </div>
          </>
        ) : (
          <div style={{ fontSize: 12, color: "#64748b" }}>{t("sp.selectOrCreate")}</div>
        )}
      </div>

      </>)}

      {/* Project Metadata Card — shown when section is "info" or unset */}
      {(section === "info" || !section) && (<>
      {/* Project Metadata Card */}
      {project && (
        <div style={{ border: "1px solid #e2e8f0", borderRadius: 16, padding: compact ? 12 : 16, background: "#f8fafc" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
            <div style={{ fontWeight: 800, fontSize: 16 }}>{t("sp.projectInfo")}</div>
            <span style={{ fontSize: 12, color: "#64748b", background: "#e2e8f0", padding: "2px 8px", borderRadius: 6 }}>{projectId}</span>
          </div>
          <SectionTitle>{t("sp.site")}</SectionTitle>
          <MetaGrid compact={compact}>
            <MetaField label={t("field.project")} value={projectId} />
            <MetaField label={t("field.projectNum")} value={plantInfo?.project_number} />
            <MetaField label={t("field.siteId")} value={plantInfo?.site_id} />
            <MetaField label={t("field.latLong")} value={plantInfo?.lat_long} />
            <MetaField label={t("field.windLoad")} value={plantInfo?.wind_load} />
            <MetaField label={t("field.snowLoad")} value={plantInfo?.snow_load} />
            <MetaField label={t("field.issueDate")} value={plantInfo?.issue_date} />
            <MetaField label={t("field.nextracker")} value={plantInfo?.nextracker_model} />
          </MetaGrid>

          <SectionTitle>Zones / Rows</SectionTitle>
          <MetaGrid compact={compact}>
            <MetaField label="Zones / Sections" value={formatMetaValue(zoneCount)} />
            <MetaField label="Physical Rows" value={formatMetaValue(physicalRowCount)} />
            <MetaField label="Rows With Work" value={formatMetaValue(rowsWithWork)} />
            <MetaField label={t("field.blocks")} value={formatMetaValue(project.block_count)} />
          </MetaGrid>

          <SectionTitle>Piers / Trackers</SectionTitle>
          <MetaGrid compact={compact}>
            <MetaField label={t("field.piers")} value={formatMetaValue(project.pier_count)} />
            <MetaField label={t("field.trackers")} value={formatMetaValue(project.tracker_count)} />
            <MetaField label="Tracker Rows" value={formatMetaValue(trackerRowCount)} />
            <MetaField label={t("field.blocks")} value={formatMetaValue(project.block_count)} />
          </MetaGrid>

          <SectionTitle>DC Zone</SectionTitle>
          <MetaGrid compact={compact}>
            <MetaField label="DC Zones" value={formatMetaValue(firstDefined(plantInfo?.dc_zones, zoneCount))} />
            <MetaField label="String Zones" value={formatMetaValue(zoneCount)} />
            <MetaField label="Panels / Modules" value={formatMetaValue(panelCount)} />
            <MetaField label={t("field.totalStrings")} value={formatMetaValue(stringCount)} />
            <MetaField label="Optimizers" value={formatMetaValue(optimizerCount)} />
            <MetaField label={t("field.dccb")} value={formatMetaValue(plantInfo?.dccb)} />
            <MetaField label={t("field.modulesPerString")} value={formatMetaValue(modulesPerString)} />
            <MetaField label="Optimizers / String" value={formatMetaValue(optimizersPerString)} />
            <MetaField label={t("field.stringGroups")} value={formatMetaValue(plantInfo?.string_groups)} />
          </MetaGrid>

          <SectionTitle>AC Zone</SectionTitle>
          <MetaGrid compact={compact}>
            <MetaField label={t("field.inverters")} value={plantInfo?.inverters} />
            <MetaField label="Transformers" value={formatMetaValue(firstDefined(plantInfo?.transformers, project.transformer_count))} />
            <MetaField label={t("field.totalOutput")} value={plantInfo?.total_output_mw} />
            <MetaField label="AC Zones" value={formatMetaValue(firstDefined(plantInfo?.ac_zones, project.ac_zone_count))} />
          </MetaGrid>

          <SectionTitle>Storage Zone</SectionTitle>
          <MetaGrid compact={compact}>
            <MetaField label="Batteries" value={formatMetaValue(firstDefined(plantInfo?.batteries, project.battery_count))} />
            <MetaField label="Storage Zones" value={formatMetaValue(firstDefined(plantInfo?.storage_zones, project.storage_zone_count))} />
            <MetaField label="PCS / Inverters" value={formatMetaValue(firstDefined(plantInfo?.pcs, project.pcs_count))} />
            <MetaField label="Capacity (MWh)" value={formatMetaValue(firstDefined(plantInfo?.storage_capacity_mwh, project.storage_capacity_mwh))} />
          </MetaGrid>

          <SectionTitle>Cameras / Security</SectionTitle>
          <MetaGrid compact={compact}>
            <MetaField label="Cameras" value={formatMetaValue(firstDefined(plantInfo?.cameras, project.camera_count))} />
            <MetaField label="Camera Zones" value={formatMetaValue(firstDefined(plantInfo?.camera_zones, project.camera_zone_count))} />
            <MetaField label="Network Devices" value={formatMetaValue(firstDefined(plantInfo?.network_devices, project.network_device_count))} />
            <MetaField label="Parse Scope" value={project.parse_scope} />
          </MetaGrid>

          <SectionTitle>{t("sp.module")}</SectionTitle>
          <MetaGrid compact={compact}>
            <MetaField label={t("field.modulePower")} value={plantInfo?.module_capacity_w} />
            <MetaField label={t("field.length")} value={plantInfo?.module_length_m} />
            <MetaField label={t("field.width")} value={plantInfo?.module_width_m} />
            <MetaField label={t("field.pitch")} value={plantInfo?.pitch_m} />
          </MetaGrid>
          <SectionTitle>{t("sp.validation")}</SectionTitle>
          <MetaGrid compact={compact}>
            <ValidationField
              label={t("field.trackers")}
              actual={project.tracker_count}
              expected={plantInfo?.expected_trackers}
              tolerance={plantInfo?.tolerance_ratio ?? 0.05}
            />
            <ValidationField
              label={t("field.piers")}
              actual={project.pier_count}
              expected={plantInfo?.expected_piers}
              tolerance={plantInfo?.tolerance_ratio ?? 0.05}
            />
            <ValidationField
              label={t("field.totalModules")}
              actual={plantInfo?.total_modules}
              expected={plantInfo?.expected_modules_from_bom}
              tolerance={plantInfo?.tolerance_ratio ?? 0.05}
            />
            <MetaField label={t("field.tolerance")} value={`±${Math.round((plantInfo?.tolerance_ratio ?? 0.05) * 100)}%`} />
          </MetaGrid>

          {plantInfo?.notes && <div style={{ marginTop: 8, fontSize: 12, color: "#475569" }}>{plantInfo.notes}</div>}
          <div style={{ marginTop: 10 }}>
            {!editingPlant ? (
              <button onClick={() => { setPlantDraft({ ...plantInfo }); setEditingPlant(true); }} style={{ fontSize: 12, padding: "4px 10px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer" }}>
                {t("sp.editPlantInfo")}
              </button>
            ) : (
              <div style={{ display: "grid", gridTemplateColumns: compact ? "1fr" : "1fr 1fr 1fr", gap: 8 }}>
                <PlantInput label="Total Output (MW)" field="total_output_mw" draft={plantDraft} setDraft={setPlantDraft} />
                <PlantInput label="Total Strings" field="total_strings" draft={plantDraft} setDraft={setPlantDraft} />
                <PlantInput label="Total Modules" field="total_modules" draft={plantDraft} setDraft={setPlantDraft} />
                <PlantInput label="Inverters" field="inverters" draft={plantDraft} setDraft={setPlantDraft} />
                <PlantInput label="DCCB" field="dccb" draft={plantDraft} setDraft={setPlantDraft} />
                <PlantInput label="Devices" field="devices" draft={plantDraft} setDraft={setPlantDraft} />
                <PlantInput label="DC Zones" field="dc_zones" draft={plantDraft} setDraft={setPlantDraft} />
                <PlantInput label="AC Zones" field="ac_zones" draft={plantDraft} setDraft={setPlantDraft} />
                <PlantInput label="Transformers" field="transformers" draft={plantDraft} setDraft={setPlantDraft} />
                <PlantInput label="Storage Zones" field="storage_zones" draft={plantDraft} setDraft={setPlantDraft} />
                <PlantInput label="Batteries" field="batteries" draft={plantDraft} setDraft={setPlantDraft} />
                <PlantInput label="PCS / Inverters" field="pcs" draft={plantDraft} setDraft={setPlantDraft} />
                <PlantInput label="Storage Capacity (MWh)" field="storage_capacity_mwh" draft={plantDraft} setDraft={setPlantDraft} />
                <PlantInput label="Camera Zones" field="camera_zones" draft={plantDraft} setDraft={setPlantDraft} />
                <PlantInput label="Cameras" field="cameras" draft={plantDraft} setDraft={setPlantDraft} />
                <PlantInput label="Network Devices" field="network_devices" draft={plantDraft} setDraft={setPlantDraft} />
                <PlantInput label="Tolerance (0-1)" field="tolerance_ratio" draft={plantDraft} setDraft={setPlantDraft} />
                <div style={{ gridColumn: compact ? undefined : "1 / -1" }}>
                  <PlantInput label="Notes" field="notes" draft={plantDraft} setDraft={setPlantDraft} />
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <button onClick={handlePlantSave} style={{ fontSize: 12, padding: "6px 14px", borderRadius: 6, border: "none", background: "#0f172a", color: "#fff", cursor: "pointer" }}>{t("app.save")}</button>
                  <button onClick={() => setEditingPlant(false)} style={{ fontSize: 12, padding: "6px 14px", borderRadius: 6, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer" }}>{t("app.cancel")}</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      </>)}

      {error && <div style={{ color: "#b00020" }}>{error}</div>}

      {busy && <BusyOverlay message={busy} />}
      {confirmState && (
        <ConfirmModal
          title={confirmState.title}
          message={confirmState.message}
          confirmLabel={confirmState.confirmLabel}
          danger={confirmState.danger}
          onConfirm={confirmState.action}
          onCancel={() => setConfirmState(null)}
        />
      )}
    </div>
  );
}

function firstDefined(...values: any[]) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function formatMetaValue(value: any) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value.toLocaleString();
  return value;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, color: "#475569", textTransform: "uppercase", letterSpacing: 0.5, marginTop: 14, marginBottom: 6, borderBottom: "1px solid #e2e8f0", paddingBottom: 3 }}>
      {children}
    </div>
  );
}

function MetaGrid({ children, compact }: { children: React.ReactNode; compact: boolean }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: compact ? "1fr 1fr" : "repeat(4, 1fr)", gap: compact ? "8px 12px" : "8px 20px", fontSize: 13 }}>
      {children}
    </div>
  );
}

function MetaField({ label, value }: { label: string; value: any }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: "#64748b", marginBottom: 2 }}>{label}</div>
      <div style={{ fontWeight: 600, fontSize: 14 }}>{value ?? "-"}</div>
    </div>
  );
}

function ValidationField({ label, actual, expected, tolerance }: { label: string; actual: any; expected: any; tolerance: number }) {
  const hasBoth = typeof actual === "number" && typeof expected === "number" && expected > 0;
  let status: "pass" | "fail" | "unknown" = "unknown";
  let diffPct = 0;
  if (hasBoth) {
    diffPct = (actual - expected) / expected;
    status = Math.abs(diffPct) <= tolerance ? "pass" : "fail";
  }
  const color = status === "pass" ? "#16a34a" : status === "fail" ? "#dc2626" : "#94a3b8";
  const icon = status === "pass" ? "✓" : status === "fail" ? "⚠" : "—";
  return (
    <div>
      <div style={{ fontSize: 11, color: "#64748b", marginBottom: 2 }}>{label}</div>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontWeight: 700, fontSize: 14, color }}>{icon}</span>
        <span style={{ fontWeight: 600, fontSize: 13 }}>
          {actual?.toLocaleString?.() ?? actual ?? "-"}
          {hasBoth && <span style={{ color: "#64748b", fontWeight: 400 }}> / {expected.toLocaleString()}</span>}
        </span>
      </div>
      {hasBoth && (
        <div style={{ fontSize: 10, color, marginTop: 1 }}>
          {diffPct >= 0 ? "+" : ""}{(diffPct * 100).toFixed(1)}%
        </div>
      )}
    </div>
  );
}

function fileDisplayName(file: any): string {
  return file?.original_name || file?.filename || "Unnamed file";
}

function fileSizeMb(file: any): string {
  const bytes = Number(file?.size_bytes ?? file?.size ?? 0);
  return bytes > 0 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : "-";
}

function FileReadinessCheck({ files }: { files: any[] }) {
  const countByKind = files.reduce<Record<string, number>>((acc, file) => {
    const kind = file.kind || "other";
    acc[kind] = (acc[kind] || 0) + 1;
    return acc;
  }, {});
  const pdfCount = files.filter((file) => fileDisplayName(file).toLowerCase().endsWith(".pdf")).length;
  const supportingCount = files.filter((file) => !["construction_pdf", "ramming_pdf"].includes(file.kind)).length;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(145px, 1fr))", gap: 10, padding: "8px 0 10px", borderTop: "1px solid #e2e8f0", borderBottom: "1px solid #e2e8f0", marginBottom: 10 }}>
      <ReadinessItem label="Construction" value={countByKind.construction_pdf ? "Ready" : "Missing"} tone={countByKind.construction_pdf ? "ok" : "bad"} />
      <ReadinessItem label="Ramming" value={countByKind.ramming_pdf ? "Ready" : "Conditional"} tone={countByKind.ramming_pdf ? "ok" : "warn"} />
      <ReadinessItem label="Supporting" value={`${supportingCount} file${supportingCount === 1 ? "" : "s"}`} tone={supportingCount ? "ok" : "muted"} />
      <ReadinessItem label="PDF scan set" value={`${pdfCount} PDF${pdfCount === 1 ? "" : "s"}`} tone={pdfCount ? "ok" : "muted"} />
    </div>
  );
}

function ReadinessItem({ label, value, tone }: { label: string; value: string; tone: "ok" | "warn" | "bad" | "muted" }) {
  const color = tone === "ok" ? "#15803d" : tone === "warn" ? "#b45309" : tone === "bad" ? "#dc2626" : "#64748b";
  return (
    <div>
      <div style={{ fontSize: 11, color: "#64748b", marginBottom: 2, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 13, color, fontWeight: 700 }}>{value}</div>
    </div>
  );
}

function ElectricalReadinessCheck({ strings, inverters, dccb, fileCount }: { strings: any; inverters: any; dccb: any; fileCount: number }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(145px, 1fr))", gap: 10, padding: "8px 0 10px", borderTop: "1px solid #e2e8f0", borderBottom: "1px solid #e2e8f0", marginBottom: 10 }}>
      <ReadinessItem label="Strings" value={formatMetaValue(strings) || "Missing"} tone={strings ? "ok" : "muted"} />
      <ReadinessItem label="Inverters" value={formatMetaValue(inverters) || "Missing"} tone={inverters ? "ok" : "muted"} />
      <ReadinessItem label="DCCB" value={formatMetaValue(dccb) || "Missing"} tone={dccb ? "ok" : "muted"} />
      <ReadinessItem label="Electrical files" value={`${fileCount} file${fileCount === 1 ? "" : "s"}`} tone={fileCount ? "ok" : "muted"} />
    </div>
  );
}

function BatchUploadField({ onUpload, disabled }: { onUpload: (files: File[]) => void; disabled?: boolean }) {
  return (
    <div style={{ border: "1px dashed #94a3b8", borderRadius: 8, padding: 10, background: disabled ? "#f1f5f9" : "#f8fafc", opacity: disabled ? 0.6 : 1, marginBottom: 10 }}>
      <div style={{ fontSize: 11, color: "#64748b", marginBottom: 6, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>Batch files</div>
      <input
        type="file"
        accept={FILE_ACCEPT}
        multiple
        disabled={disabled}
        onChange={(e) => {
          const selected = Array.from(e.target.files || []);
          if (selected.length > 0) {
            onUpload(selected);
            e.target.value = "";
          }
        }}
        style={{ fontSize: 12, width: "100%" }}
      />
    </div>
  );
}

function UploadedFilesList({ files }: { files: any[] }) {
  if (files.length === 0) return null;
  const order = ["construction_pdf", "ramming_pdf", "overlay_image", "block_mapping", "other"];
  const sorted = [...files].sort((a, b) => {
    const ak = order.indexOf(a.kind);
    const bk = order.indexOf(b.kind);
    if (ak !== bk) return (ak < 0 ? order.length : ak) - (bk < 0 ? order.length : bk);
    return fileDisplayName(a).localeCompare(fileDisplayName(b));
  });
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, color: "#64748b", marginBottom: 4, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>Uploaded files</div>
      <div style={{ display: "grid", gap: 0, fontSize: 12, color: "#334155" }}>
        {sorted.map((file) => (
          <div key={file.id ?? `${file.kind}-${file.filename}`} style={{ display: "grid", gridTemplateColumns: "minmax(130px, 0.8fr) minmax(180px, 2fr) minmax(70px, 0.4fr)", gap: 8, padding: "5px 0", borderTop: "1px solid #e2e8f0", alignItems: "center" }}>
            <span style={{ fontWeight: 700, color: "#475569" }}>{FILE_KIND_LABELS[file.kind] || file.kind || "File"}</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={fileDisplayName(file)}>{fileDisplayName(file)}</span>
            <span style={{ color: "#64748b", textAlign: "right" }}>{fileSizeMb(file)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function FileUploadField({ label, kind, files, onUpload, disabled }: { label: string; kind: UploadKind; files: any[]; onUpload: (kind: UploadKind, file: File) => void; disabled?: boolean }) {
  const existing = files.filter((f) => f.kind === kind);
  return (
    <div style={{ border: "1px dashed #cbd5e1", borderRadius: 8, padding: 10, background: disabled ? "#f1f5f9" : "#f8fafc", opacity: disabled ? 0.6 : 1 }}>
      <div style={{ fontSize: 11, color: "#64748b", marginBottom: 4, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>{label}</div>
      {existing.length > 0 && (
        <div style={{ fontSize: 12, color: "#334155", marginBottom: 6 }}>
          {existing.map((f) => (
            <div key={f.id}>✓ {f.original_name || f.filename} ({(f.size_bytes / (1024 * 1024)).toFixed(1)} MB)</div>
          ))}
        </div>
      )}
      <input
        type="file"
        accept={FILE_ACCEPT}
        disabled={disabled}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) {
            onUpload(kind, f);
            e.target.value = "";
          }
        }}
        style={{ fontSize: 12 }}
      />
    </div>
  );
}

function PlantInput({ label, field, draft, setDraft }: { label: string; field: string; draft: any; setDraft: (d: any) => void }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: "#64748b", marginBottom: 2 }}>{label}</div>
      <input
        value={draft[field] ?? ""}
        onChange={(e) => setDraft({ ...draft, [field]: e.target.value || null })}
        style={{ width: "100%", padding: "6px 8px", borderRadius: 6, border: "1px solid #d1d5db", fontSize: 13, boxSizing: "border-box" }}
      />
    </div>
  );
}
