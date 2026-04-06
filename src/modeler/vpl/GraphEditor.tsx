import styles from './GraphEditor.module.css';

export function GraphEditor() {
  return (
    <div className={styles.editor}>
      <div className={styles.gridBackground} />
      <div className={styles.mockGraph}>
        <div className={styles.mockNode} style={{ top: 60, left: 80 }}>
          <div className={styles.mockNodeHeader}>Get Attribute</div>
          <div className={styles.mockNodeBody}>alive</div>
          <div className={styles.mockPortOut} />
        </div>

        <svg className={styles.mockConnection} viewBox="0 0 400 300">
          <path
            d="M 218 95 C 280 95, 240 160, 302 160"
            fill="none"
            stroke="#4cc9f0"
            strokeWidth="2"
            opacity="0.6"
          />
          <path
            d="M 218 95 C 280 95, 240 230, 302 230"
            fill="none"
            stroke="#4cc9f0"
            strokeWidth="2"
            opacity="0.6"
          />
        </svg>

        <div className={styles.mockNode} style={{ top: 130, left: 300 }}>
          <div className={styles.mockNodeHeader}>Compare</div>
          <div className={styles.mockNodeBody}>== true</div>
          <div className={styles.mockPortIn} />
          <div className={styles.mockPortOut} />
        </div>

        <div className={styles.mockNode} style={{ top: 200, left: 300 }}>
          <div className={styles.mockNodeHeader}>Count Neighbors</div>
          <div className={styles.mockNodeBody}>alive == true</div>
          <div className={styles.mockPortIn} />
          <div className={styles.mockPortOut} />
        </div>
      </div>

      <div className={styles.watermark}>
        <div className={styles.watermarkTitle}>Visual Programming Editor</div>
        <div className={styles.watermarkSub}>
          Node graph for defining update rules — powered by React Flow (coming soon)
        </div>
      </div>
    </div>
  );
}
