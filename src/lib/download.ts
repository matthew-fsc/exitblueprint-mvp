// Browser-download helpers. Centralizes the createObjectURL → anchor → click →
// revokeObjectURL dance that ~4 call sites had each copied inline (two of them
// omitting the appendChild/remove that some browsers, notably Firefox, require
// for a programmatic click). Keep the download shape in one place so it stays
// consistent and leak-free.

import { invokeFunctionBlob } from './supabase';

// Trigger a browser download of an in-memory Blob under the given filename.
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Render a generated document to PDF via the compute gateway and download it.
// Wraps the render-document-pdf function + downloadBlob for the report callers.
export async function downloadDocumentPdf(
  assessmentId: string,
  docType: string,
  filename: string,
): Promise<void> {
  const blob = await invokeFunctionBlob('render-document-pdf', {
    assessment_id: assessmentId,
    doc_type: docType,
  });
  downloadBlob(blob, filename);
}
