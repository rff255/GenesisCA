import { useEffect, useState } from 'react';
import { useModel } from '../model/ModelContext';
import { SimulatorView } from '../simulator/SimulatorView';
import { serializeModel, modelFilename, downloadJSON } from '../model/fileOperations';
import type { CAModel } from '../model/types';

const GENESIS_URL = 'https://genesisca.online';

/**
 * Chromeless standalone shell for a standalone-simulation export. Seeds the
 * in-memory ModelProvider with the embedded model, renders the full Simulator,
 * and layers a centered "welcome" info modal (R2 — all presentation metadata,
 * shown on open) + a "Download model" action (R1 — the .html is also a
 * recoverable model source) on top.
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

/**
 * Reopen button (bottom-right, out of the way of both side panels) + a centered
 * "welcome" modal that pops up in front on load so the viewer is greeted with
 * what they just opened, and can close it whenever.
 */
function AboutOverlay({ model }: { model: CAModel }) {
  const p = model.properties;
  const [open, setOpen] = useState(true); // welcome: shown on first open

  // Esc closes the modal. Capture-phase + stopPropagation so it doesn't also
  // trigger the simulator's Esc = Reset.
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [open]);

  const handleDownload = () => {
    void downloadJSON(serializeModel(model), modelFilename(model));
  };

  return (
    <>
      {!open && (
        <button
          onClick={() => setOpen(true)}
          title="About this model"
          style={{
            position: 'absolute', right: 16, bottom: 64, zIndex: 46,
            width: 42, height: 42, borderRadius: '50%', cursor: 'pointer',
            background: 'var(--color-accent, #e8a13a)', color: '#16181d',
            border: 'none', fontSize: 22, fontWeight: 700, lineHeight: 1,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: '0 6px 20px #000a',
          }}
        >ⓘ</button>
      )}

      {open && (
        <div
          onClick={() => setOpen(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 50,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
            background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)',
            fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: 'min(600px, 94vw)', maxHeight: '86vh', overflowY: 'auto',
              background: 'var(--color-bg-panel, #16181d)', color: 'var(--color-text, #d8dae0)',
              border: '1px solid var(--color-border, #2a2e37)', borderRadius: 16,
              boxShadow: '0 24px 70px #000c', fontSize: 14,
            }}
          >
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 18, padding: '22px 24px 16px' }}>
              {p.thumbnail && (
                <img
                  src={p.thumbnail}
                  alt=""
                  style={{ width: 104, height: 104, borderRadius: 12, objectFit: 'cover', flex: 'none', imageRendering: 'pixelated', border: '1px solid var(--color-border, #2a2e37)' }}
                />
              )}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontSize: 11, letterSpacing: '.6px', textTransform: 'uppercase', color: 'var(--color-accent, #e8a13a)', marginBottom: 3 }}>
                  Standalone simulation
                </div>
                <div style={{ fontSize: 23, fontWeight: 700, lineHeight: 1.15, color: 'var(--color-text, #ecebe6)' }}>
                  {p.name || 'Untitled model'}
                </div>
                <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 10, rowGap: 3 }}>
                  <Meta label="Rule author" value={p.author} />
                  <Meta label="Project author" value={p.modelAuthor} />
                </div>
                {(p.tags || []).length > 0 && (
                  <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {(p.tags || []).map(t => <span key={t} style={chipStyle}>{t}</span>)}
                  </div>
                )}
              </div>
              <button
                onClick={() => setOpen(false)}
                title="Close (Esc)"
                style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--color-text-muted, #8a8f9a)', cursor: 'pointer', fontSize: 24, lineHeight: 1, flex: 'none', padding: 0 }}
              >×</button>
            </div>

            {p.description && <Section title="Summary"><div style={{ lineHeight: 1.5 }}>{p.description}</div></Section>}
            {p.ruleDescription && (
              <Section title="Rule description">
                <div style={{ color: 'var(--color-text-muted, #b7bcc6)', whiteSpace: 'pre-wrap', lineHeight: 1.55 }}>{p.ruleDescription}</div>
              </Section>
            )}

            <Section title="How to use">
              <div style={{ color: 'var(--color-text-muted, #b7bcc6)', lineHeight: 1.55 }}>
                Use the transport bar to <b style={{ color: 'var(--color-text, #d8dae0)' }}>play / pause / step / reset</b>,
                the left panel to tune parameters, and paint on the grid to edit cells. Reopen this window any time with
                the <b style={{ color: 'var(--color-accent, #e8a13a)' }}>ⓘ</b> button.
              </div>
            </Section>

            {/* Footer */}
            <div style={{ borderTop: '1px solid var(--color-border, #2a2e37)', padding: '16px 24px 20px', display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                <button onClick={handleDownload} style={dlBtnStyle}>⤓ Download model (.gcaproj)</button>
                <button onClick={() => setOpen(false)} style={primaryBtnStyle}>Start exploring →</button>
              </div>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted, #8a8f9a)', lineHeight: 1.5 }}>
                Made with{' '}
                <a href={GENESIS_URL} target="_blank" rel="noopener noreferrer"
                   style={{ color: 'var(--color-accent, #e8a13a)', fontWeight: 700, textDecoration: 'none' }}>
                  GenesisCA
                </a>
                {' '}— a free, browser-based cellular-automata IDE. This file is also the full model:
                open it in GenesisCA (File → Load) to edit the rule.
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** A labeled metadata row. Renders a muted "—" when the value is empty so the
 *  field is never silently absent. */
function Meta({ label, value }: { label: string; value?: string }) {
  return (
    <>
      <div style={{ fontSize: 12.5, color: 'var(--color-text-muted, #8a8f9a)' }}>{label}</div>
      <div style={{ fontSize: 12.5, color: value ? 'var(--color-text, #c8ccd4)' : 'var(--color-text-muted, #5f646d)' }}>
        {value || '—'}
      </div>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: '0 24px 16px' }}>
      <div style={{ fontSize: 11, letterSpacing: '.5px', textTransform: 'uppercase', color: 'var(--color-text-muted, #8a8f9a)', margin: '4px 0 6px' }}>{title}</div>
      {children}
    </div>
  );
}

const chipStyle: React.CSSProperties = {
  fontSize: 11.5, padding: '2px 9px', borderRadius: 20,
  background: 'var(--color-accent-soft, #e8a13a22)', color: 'var(--color-accent, #e8a13a)',
  border: '1px solid #e8a13a44',
};

const dlBtnStyle: React.CSSProperties = {
  padding: '9px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 13,
  background: 'var(--color-bg, #0f1116)', color: 'var(--color-text, #d8dae0)',
  border: '1px solid var(--color-border, #2a2e37)',
};

const primaryBtnStyle: React.CSSProperties = {
  padding: '9px 16px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600,
  background: 'var(--color-accent, #e8a13a)', color: '#16181d', border: 'none',
};
