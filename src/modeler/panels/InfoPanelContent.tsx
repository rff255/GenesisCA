import { useRef, useState, type ChangeEvent } from 'react';
import { useModel } from '../../model/ModelContext';
import type { PanelContentProps } from '../ModelerDetailContext';
import styles from './PanelContent.module.css';

const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const THUMBNAIL_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';

/** Model "Info" panel — presentation metadata only (name, authors, description,
 *  thumbnail, tags). Split out of the Properties panel so Properties is left with
 *  Structure / Execution / Indicators. Not master-detail: a single form. */
export function InfoPanelContent(_props: PanelContentProps = {}) {
  const { model, updateProperties } = useModel();
  const { properties } = model;
  const [tagInput, setTagInput] = useState('');
  const [thumbError, setThumbError] = useState('');
  const thumbInputRef = useRef<HTMLInputElement | null>(null);

  const handleThumbnailPick = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (!file) return;
    if (file.size > THUMBNAIL_MAX_BYTES) {
      setThumbError(`File is ${(file.size / 1024 / 1024).toFixed(2)} MB — the limit is 2 MB.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') return;
      setThumbError('');
      updateProperties({ thumbnail: result });
    };
    reader.onerror = () => setThumbError('Could not read the file.');
    reader.readAsDataURL(file);
  };

  const addTag = () => {
    const tag = tagInput.trim().toLowerCase();
    if (!tag || (properties.tags || []).includes(tag)) return;
    updateProperties({ tags: [...(properties.tags || []), tag] });
    setTagInput('');
  };

  const removeTag = (tag: string) => {
    updateProperties({ tags: (properties.tags || []).filter(t => t !== tag) });
  };

  return (
    <div className={styles.fieldGroup}>
      <div className={styles.section}>
        <div className={styles.sectionTitle}>Presentation</div>
        <div className={styles.fieldGroup}>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Name</label>
            <input
              className={styles.textInput}
              value={properties.name}
              onChange={e => updateProperties({ name: e.target.value })}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Rule Author</label>
            <input
              className={styles.textInput}
              value={properties.author}
              onChange={e => updateProperties({ author: e.target.value })}
              placeholder="Originator of the CA rule"
            />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>GenesisCA Project Author</label>
            <input
              className={styles.textInput}
              value={properties.modelAuthor}
              onChange={e => updateProperties({ modelAuthor: e.target.value })}
              placeholder="Who built this GenesisCA project"
            />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Description</label>
            <textarea
              className={styles.textArea}
              rows={4}
              value={properties.description}
              onChange={e => updateProperties({ description: e.target.value })}
            />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Thumbnail</label>
            <input
              ref={thumbInputRef}
              type="file"
              accept={THUMBNAIL_ACCEPT}
              onChange={handleThumbnailPick}
              style={{ display: 'none' }}
            />
            {properties.thumbnail ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
                <img
                  src={properties.thumbnail}
                  alt="Model thumbnail"
                  style={{
                    maxWidth: 200, maxHeight: 200, borderRadius: 4,
                    border: '1px solid #2d4059', background: '#0d1117',
                  }}
                />
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    className={styles.addButton}
                    style={{ flex: 'none', padding: '4px 10px', fontSize: '0.7rem' }}
                    onClick={() => thumbInputRef.current?.click()}
                  >
                    Replace
                  </button>
                  <button
                    className={styles.deleteButton}
                    style={{ padding: '4px 10px', fontSize: '0.7rem' }}
                    onClick={() => { setThumbError(''); updateProperties({ thumbnail: undefined }); }}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ) : (
              <button
                className={styles.addButton}
                style={{ flex: 'none', alignSelf: 'flex-start', padding: '4px 10px', fontSize: '0.72rem' }}
                onClick={() => thumbInputRef.current?.click()}
              >
                Choose Image/GIF…
              </button>
            )}
            <span style={{ color: '#8090a0', fontSize: '0.62rem' }}>
              PNG, JPEG, GIF, or WebP — up to 2 MB. Shown on hover in the Models Library.
            </span>
            {thumbError && (
              <span style={{ color: '#e05050', fontSize: '0.65rem' }}>{thumbError}</span>
            )}
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Tags</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
              {(properties.tags || []).map(tag => (
                <span
                  key={tag}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 3,
                    padding: '1px 8px', background: 'rgba(76,201,240,0.12)',
                    border: '1px solid rgba(76,201,240,0.25)', borderRadius: 10,
                    fontSize: '0.68rem', color: '#4cc9f0',
                  }}
                >
                  {tag}
                  <button
                    onClick={() => removeTag(tag)}
                    style={{
                      background: 'none', border: 'none', color: '#f44336',
                      cursor: 'pointer', fontSize: '0.7rem', padding: 0, lineHeight: 1,
                    }}
                  >
                    x
                  </button>
                </span>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              <input
                className={styles.textInput}
                style={{ flex: 1 }}
                placeholder="Add tag..."
                value={tagInput}
                onChange={e => setTagInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
              />
              <button className={styles.addButton} style={{ padding: '2px 8px' }} onClick={addTag}>+</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
