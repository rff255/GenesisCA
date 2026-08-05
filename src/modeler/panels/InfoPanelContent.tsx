import { useRef, useState, type ChangeEvent } from 'react';
import { useModel } from '../../model/ModelContext';
import { ThumbMedia } from '../../components/ThumbMedia';
import {
  THUMBNAIL_ACCEPT, THUMBNAIL_FORMATS_LABEL, THUMBNAIL_MAX_BYTES,
} from '../../model/thumbnail';
import { todayCreatedDate } from '../../model/createdDate';
import type { PanelContentProps } from '../ModelerDetailContext';
import styles from './PanelContent.module.css';

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
            <label className={styles.fieldLabel}>Creation date</label>
            <div style={{ display: 'flex', gap: 4 }}>
              <input
                className={styles.textInput}
                style={{ flex: 1, colorScheme: 'dark' }}
                type="date"
                value={properties.createdDate ?? ''}
                onChange={e => updateProperties({ createdDate: e.target.value || undefined })}
              />
              <button
                className={styles.addButton}
                style={{ flex: 'none', padding: '2px 8px', fontSize: '0.68rem' }}
                title="Set to today"
                onClick={() => updateProperties({ createdDate: todayCreatedDate() })}
              >
                Today
              </button>
              {properties.createdDate && (
                <button
                  className={styles.deleteButton}
                  style={{ flex: 'none', padding: '2px 8px', fontSize: '0.68rem' }}
                  title="Clear the creation date"
                  onClick={() => updateProperties({ createdDate: undefined })}
                >
                  Clear
                </button>
              )}
            </div>
            <span style={{ color: '#8090a0', fontSize: '0.62rem' }}>
              When this model was made. Shown on its Models Library card and used by the
              Newest/Oldest sort. Left blank, no date is shown.
            </span>
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Summary</label>
            <textarea
              className={styles.textArea}
              rows={3}
              value={properties.description}
              onChange={e => updateProperties({ description: e.target.value })}
              placeholder="Short summary shown on the Models Library card"
            />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Rule Description</label>
            <textarea
              className={styles.textArea}
              rows={8}
              value={properties.ruleDescription ?? ''}
              onChange={e => updateProperties({ ruleDescription: e.target.value })}
              placeholder="Elaborate on how the rule works and anything else worth documenting"
            />
          </div>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>Simulator Instructions</label>
            <textarea
              className={styles.textArea}
              rows={6}
              value={properties.instructions ?? ''}
              onChange={e => updateProperties({ instructions: e.target.value })}
              placeholder="How to interact with this model, what to try, what to look for"
            />
            <span style={{ color: '#8090a0', fontSize: '0.62rem' }}>
              Shown in the Simulator behind an "Instructions" button. Line breaks are preserved.
            </span>
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
                <ThumbMedia
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
                Choose Image/GIF/WebM…
              </button>
            )}
            <span style={{ color: '#8090a0', fontSize: '0.62rem' }}>
              {THUMBNAIL_FORMATS_LABEL} — up to 2 MB. Shown on hover in the Models Library.
              A WebM clip (e.g. a simulator recording) plays on loop.
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
