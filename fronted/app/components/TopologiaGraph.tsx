'use client';

import { useEffect, useRef } from 'react';
import { DataSet } from 'vis-data';
import { Network } from 'vis-network';
import type { ServerSummary } from '../types';

const STATUS_COLOR: Record<string, string> = {
  OK: '#10b981',
  WARNING: '#f59e0b',
  CRITICAL: '#ef4444',
  UNKNOWN: '#475569',
};

const HUB_ID = '__hub__';

export default function TopologiaGraph({ servers }: { servers: ServerSummary[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const networkRef = useRef<Network | null>(null);
  const nodesRef = useRef<DataSet<Record<string, unknown>> | null>(null);
  const edgesRef = useRef<DataSet<Record<string, unknown>> | null>(null);

  // Crea la red vis.js una sola vez; las actualizaciones posteriores hacen
  // upsert sobre el DataSet en vez de recrear la red, para no reiniciar la
  // simulacion fisica (evita que los nodos "salten" en cada telemetria).
  useEffect(() => {
    if (!containerRef.current) return;

    const nodes = new DataSet<Record<string, unknown>>();
    const edges = new DataSet<Record<string, unknown>>();
    nodesRef.current = nodes;
    edgesRef.current = edges;

    const network = new Network(
      containerRef.current,
      { nodes, edges },
      {
        physics: {
          enabled: true,
          stabilization: { iterations: 150 },
          barnesHut: { springLength: 140, springConstant: 0.02 },
        },
        interaction: { hover: true, zoomView: true, dragView: true, dragNodes: true },
        nodes: {
          shape: 'box',
          margin: { top: 10, right: 14, bottom: 10, left: 14 },
          borderWidth: 2,
          shapeProperties: { borderRadius: 8 },
          font: { color: '#e5e7eb', size: 12, face: 'ui-sans-serif' },
        },
        edges: {
          color: { color: '#334155', highlight: '#3b82f6' },
          smooth: { enabled: true, type: 'continuous', roundness: 0.4 },
        },
      }
    );

    network.once('stabilizationIterationsDone', () => {
      network.setOptions({ physics: false });
    });

    networkRef.current = network;

    return () => {
      network.destroy();
      networkRef.current = null;
    };
  }, []);

  // Upsert de nodos/aristas cuando cambia la lista de servidores o su salud.
  useEffect(() => {
    const nodes = nodesRef.current;
    const edges = edgesRef.current;
    if (!nodes || !edges) return;

    nodes.update({
      id: HUB_ID,
      label: 'Enterprise\nSOC',
      color: { background: '#2563eb', border: '#60a5fa' },
      font: { color: '#fff', size: 13, bold: true as unknown as string },
      shape: 'box',
    });

    for (const s of servers) {
      nodes.update({
        id: s.id,
        label: `${s.name}\n(${s.healthStatus})`,
        color: { background: STATUS_COLOR[s.healthStatus], border: STATUS_COLOR[s.healthStatus] },
      });
      edges.update({ id: `edge-${s.id}`, from: HUB_ID, to: s.id });
    }

    const validIds = new Set([HUB_ID, ...servers.map((s) => s.id)]);
    const staleNodeIds = nodes.getIds().filter((id) => !validIds.has(id as string));
    if (staleNodeIds.length > 0) nodes.remove(staleNodeIds);
  }, [servers]);

  return <div ref={containerRef} className="h-[500px] w-full rounded-lg bg-gray-950/50" />;
}
