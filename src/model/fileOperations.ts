import { SCHEMA_VERSION } from './schema';
import type { CAModel } from './types';

export function serializeModel(model: CAModel): string {
  return JSON.stringify(model, null, 2);
}

export function modelFilename(model: CAModel): string {
  const base = model.properties.name
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
  return `${base || 'model'}.gcaproj`;
}

export function downloadJSON(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function readModelFile(file: File): Promise<CAModel> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const model = JSON.parse(reader.result as string) as CAModel;
        if (!model.properties || !model.attributes) {
          reject(new Error('Invalid file: missing required model fields.'));
          return;
        }
        if (
          model.schemaVersion != null &&
          model.schemaVersion > SCHEMA_VERSION
        ) {
          reject(
            new Error(
              `File uses schema version ${model.schemaVersion}, but this app supports up to version ${SCHEMA_VERSION}. Please update GenesisCA.`,
            ),
          );
          return;
        }
        model.schemaVersion = SCHEMA_VERSION;
        resolve(model);
      } catch {
        reject(new Error('Failed to parse file. Is it valid JSON?'));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file.'));
    reader.readAsText(file);
  });
}
