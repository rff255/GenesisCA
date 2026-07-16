import { useEffect, useState } from 'react';
import { useModel } from '../model/ModelContext';
import { SimulatorView } from '../simulator/SimulatorView';
import { serializeModel, modelFilename, downloadJSON } from '../model/fileOperations';
import type { CAModel } from '../model/types';

/**
 * Chromeless standalone shell for the Presentation Export. Seeds the in-memory
 * ModelProvider with the embedded model, renders the full Simulator, and layers
 * an About panel (R2 — all presentation metadata) + a "Download model" action
 * (R1 — the .html is also a recoverable model source) on top.
 */
export function ViewerApp({ model, error }: { model: CAModel | null; error: string | null }) {
  const { model: liveModel, loadModel } = useModel();
  const [ready, setReady] = useState(false);

  // Seed the provider once from the embedded model.
  useEffect(() => {
    if (model) {
      loadModel(model);
      setReady(true);
    }
  }, [model, loadModel]);

  if (error) {
    return (
      <Centered>
        <h2 style={{ color: 'var(--color-danger, #e06a5e)', margin: '0 0 8px' }}>Couldn’t load model</h2>
        <p style={{ color: 'var(--color-text-muted, #8a8f9a)', maxWidth: 420, textAlign: 'center' }}>{error}</p>
      </Centered>
    );
  }
  if (!model) {
    return (
      <Centered>
        <h2 style={{ margin: '0 0 8px' }}>GenesisCA viewer template</h2>
        <p style={{ color: 'var(--color-text-muted, #8a8f9a)', maxWidth: 460, textAlign: 'center' }}>
          No model is embedded in this file. This is the empty viewer template — export a model from GenesisCA to
          produce a runnable standalone page.
        </p>
      </Centered>
    );
  }

  return (
    <div style={{ position: 'relative', height: '100vh', width: '100vw', overflow: 'hidden' }}>
      {/* SimulatorView is always mounted; it reads the model from context once loadModel has run. */}
      {ready && <SimulatorView visible />}
      <AboutOverlay model={liveModel.properties.name ? liveModel : model} />
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        height: '100vh', width: '100vw', display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 4, padding: 24,
        color: 'var(--color-text, #d8dae0)', fontFamily: 'system-ui, sans-serif',
        background: 'var(--color-bg, #0c0d10)',
      }}
    >
      {children}
    </div>
  );
}

/** Floating ⓘ button + the About/Info panel (auto-open on first load). */
function AboutOverlay({ model }: { model: CAModel }) {
  const p = model.properties;
  const hasInfo = !!(p.author || p.modelAuthor || p.description || p.ruleDescription || (p.tags || []).length || p.thumbnail);
  const [open, setOpen] = useState(hasInfo);

  const handleDownload = () => {
    void downloadJSON(serializeModel(model), modelFilename(model));
  };

  return (
    <>
      <button
        onClick={() => setOpen(o => !o)}
        title="About this model"
        style={{
          position: 'absolute', top: 12, left: 12, zIndex: 40,
          width: 34, height: 34, borderRadius: 8, cursor: 'pointer',
          background: 'var(--color-bg-panel, #16181d)', color: 'var(--color-accent, #e8a13a)',
          border: '1px solid var(--color-border, #2a2e37)', fontSize: 17, fontWeight: 700,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >ⓘ</button>

      {open && (
        <div
          style={{
            position: 'absolute', top: 12, left: 56, zIndex: 40, width: 340, maxWidth: 'calc(100vw - 72px)',
            maxHeight: 'calc(100vh - 24px)', overflowY: 'auto',
            background: 'var(--color-bg-panel, #16181d)', color: 'var(--color-text, #d8dae0)',
            border: '1px solid var(--color-border, #2a2e37)', borderRadius: 12,
            boxShadow: '0 14px 44px #0009', fontFamily: 'system-ui, sans-serif', fontSize: 13.5,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: 16 }}>
            {p.thumbnail && (
              <img
                src={p.thumbnail}
                alt=""
                style={{ width: 72, height: 72, borderRadius: 8, objectFit: 'cover', flex: 'none', imageRendering: 'pixelated' }}
              />
            )}
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--color-text, #ecebe6)' }}>
                {p.name || 'Untitled model'}
              </div>
              {p.author && <Meta label="Rule author" value={p.author} />}
              {p.modelAuthor && <Meta label="Project author" value={p.modelAuthor} />}
              {(p.tags || []).length > 0 && (
                <div style={{ marginTop: 7, display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                  {(p.tags || []).map(t => (
                    <span key={t} style={chipStyle}>{t}</span>
                  ))}
                </div>
              )}
            </div>
            <button
              onClick={() => setOpen(false)}
              title="Close"
              style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--color-text-muted, #8a8f9a)', cursor: 'pointer', fontSize: 18, lineHeight: 1, flex: 'none' }}
            >×</button>
          </div>

          {p.description && (
            <Section title="Summary"><div>{p.description}</div></Section>
          )}
          {p.ruleDescription && (
            <Section title="Rule description">
              <div style={{ color: 'var(--color-text-muted, #b7bcc6)', whiteSpace: 'pre-wrap' }}>{p.ruleDescription}</div>
            </Section>
          )}

          <div style={{ borderTop: '1px solid var(--color-border, #2a2e37)', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button onClick={handleDownload} style={dlBtnStyle}>⤓ Download model (.gcaproj)</button>
            <div style={{ fontSize: 11.5, color: 'var(--color-text-muted, #8a8f9a)' }}>
              Made with <b style={{ color: 'var(--color-accent, #e8a13a)' }}>GenesisCA</b> · open this .html in GenesisCA to edit the model.
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ fontSize: 12, color: 'var(--color-text-muted, #8a8f9a)', marginTop: 2 }}>
      {label} · <span style={{ color: 'var(--color-text, #c8ccd4)' }}>{value}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: '0 16px 14px' }}>
      <div style={{ fontSize: 11, letterSpacing: '.4px', textTransform: 'uppercase', color: 'var(--color-text-muted, #8a8f9a)', margin: '2px 0 4px' }}>{title}</div>
      {children}
    </div>
  );
}

const chipStyle: React.CSSProperties = {
  fontSize: 11, padding: '2px 8px', borderRadius: 20,
  background: 'var(--color-accent-soft, #e8a13a22)', color: 'var(--color-accent, #e8a13a)',
  border: '1px solid #e8a13a44',
};

const dlBtnStyle: React.CSSProperties = {
  padding: '7px 12px', borderRadius: 7, cursor: 'pointer', fontSize: 13, textAlign: 'left',
  background: 'var(--color-bg, #0f1116)', color: 'var(--color-text, #d8dae0)',
  border: '1px solid var(--color-border, #2a2e37)',
};
