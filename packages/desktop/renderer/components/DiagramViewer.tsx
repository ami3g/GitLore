import React, { useRef, useEffect, useState, useCallback } from 'react';
import { TransformWrapper, TransformComponent } from 'react-zoom-pan-pinch';
import mermaid from 'mermaid';

interface DiagramViewerProps {
  code: string;
}

mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  maxEdges: 5000,
  themeVariables: {
    primaryColor: '#334155',
    primaryBorderColor: '#64748b',
    primaryTextColor: '#e2e8f0',
    lineColor: '#475569',
    secondaryColor: '#1e293b',
    tertiaryColor: '#0f172a',
    background: '#0f172a',
    mainBkg: '#1e293b',
    nodeBorder: '#475569',
  },
});

export const DiagramViewer: React.FC<DiagramViewerProps> = ({ code }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!code || !containerRef.current) return;
    setError(null);

    const render = async () => {
      try {
        const id = `mermaid-${Date.now()}`;
        const { svg } = await mermaid.render(id, code);
        if (containerRef.current) {
          containerRef.current.innerHTML = svg;
          // Force SVG to render at a readable size
          const svgEl = containerRef.current.querySelector('svg');
          if (svgEl) {
            svgEl.removeAttribute('height');
            svgEl.style.minWidth = '2000px';
            svgEl.style.width = 'max-content';
            svgEl.style.height = 'auto';
          }
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to render diagram');
      }
    };

    render();
  }, [code]);

  if (error) {
    return <div className="diagram-viewer__error">Render error: {error}</div>;
  }

  return (
    <TransformWrapper
      initialScale={0.5}
      minScale={0.05}
      maxScale={30}
      centerOnInit
      wheel={{ step: 0.15 }}
      panning={{ velocityDisabled: true }}
    >
      <TransformComponent
        wrapperClass="diagram-viewer__wrapper"
        contentClass="diagram-viewer__content"
      >
        <div ref={containerRef} className="diagram-viewer__svg" />
      </TransformComponent>
    </TransformWrapper>
  );
};
