export default function PierDetailsPanel({ selected }: any) {
  if (!selected?.pier) {
    return <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 16, background: "#fff" }}>Select a pier</div>;
  }
  const { pier, tracker, block, drawing_bundle } = selected;
  return (
    <div style={{ padding: 12, border: "1px solid #ddd", borderRadius: 16, background: "#fff" }}>
      <h3 style={{ marginTop: 0 }}>Pier details</h3>
      <div><strong>Pier:</strong> {pier.pier_code}</div>
      <div><strong>Block:</strong> {block?.block_code ?? pier.block_code}</div>
      <div><strong>Tracker:</strong> {tracker?.tracker_code ?? pier.tracker_code}</div>
      <div><strong>Row:</strong> {pier.row_num}</div>
      <div><strong>Pier type:</strong> {pier.pier_type}</div>
      <div><strong>Tracker type:</strong> {pier.tracker_type_code}</div>
      <div><strong>Local coords:</strong> ({pier.x_local?.toFixed?.(2)}, {pier.y_local?.toFixed?.(2)})</div>
      <div><strong>Tracker local:</strong> ({pier.x_tracker_local?.toFixed?.(2)}, {pier.y_tracker_local?.toFixed?.(2)})</div>
      <div><strong>Tracker sheet:</strong> {pier.tracker_sheet}</div>
      {drawing_bundle && (
        <>
          <h4>Drawing bundle</h4>
          <div><strong>Block plan:</strong> {drawing_bundle.block_pier_plan?.sheet_no}</div>
          <div><strong>Tracker typical:</strong> {drawing_bundle.tracker_typical?.sheet_no}</div>
          <div><strong>Tolerances:</strong> {drawing_bundle.pier_tolerances?.sheet_no}</div>
          <div><strong>Slope:</strong> {drawing_bundle.slope_detail?.sheet_no}</div>
        </>
      )}
    </div>
  );
}
