"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import { useStore, type Node, type NodePositionChange, type XYPosition } from "@xyflow/react";

// Alignment ("snapping") guides for the canvas: when a dragged node's edge lines
// up with another node's edge (within `distance`), we snap to it and draw a guide.

type GetHelperLinesResult = {
  horizontal?: number;
  vertical?: number;
  snapPosition: Partial<XYPosition>;
};

export function getHelperLines(
  change: NodePositionChange,
  nodes: Node[],
  distance = 6
): GetHelperLinesResult {
  const defaultResult: GetHelperLinesResult = {
    horizontal: undefined,
    vertical: undefined,
    snapPosition: { x: undefined, y: undefined },
  };
  const nodeA = nodes.find((n) => n.id === change.id);
  if (!nodeA || !change.position) return defaultResult;

  const aw = nodeA.measured?.width ?? 0;
  const ah = nodeA.measured?.height ?? 0;
  const a = {
    left: change.position.x,
    right: change.position.x + aw,
    top: change.position.y,
    bottom: change.position.y + ah,
    width: aw,
    height: ah,
  };

  let vDist = distance;
  let hDist = distance;

  return nodes
    .filter((n) => n.id !== nodeA.id)
    .reduce<GetHelperLinesResult>((result, nodeB) => {
      const bw = nodeB.measured?.width ?? 0;
      const bh = nodeB.measured?.height ?? 0;
      const b = {
        left: nodeB.position.x,
        right: nodeB.position.x + bw,
        top: nodeB.position.y,
        bottom: nodeB.position.y + bh,
        width: bw,
        height: bh,
      };

      // --- vertical guides (x alignment) ---
      const leftLeft = Math.abs(a.left - b.left);
      if (leftLeft < vDist) {
        result.snapPosition.x = b.left;
        result.vertical = b.left;
        vDist = leftLeft;
      }
      const rightRight = Math.abs(a.right - b.right);
      if (rightRight < vDist) {
        result.snapPosition.x = b.right - a.width;
        result.vertical = b.right;
        vDist = rightRight;
      }
      const leftRight = Math.abs(a.left - b.right);
      if (leftRight < vDist) {
        result.snapPosition.x = b.right;
        result.vertical = b.right;
        vDist = leftRight;
      }
      const rightLeft = Math.abs(a.right - b.left);
      if (rightLeft < vDist) {
        result.snapPosition.x = b.left - a.width;
        result.vertical = b.left;
        vDist = rightLeft;
      }
      // center-x alignment
      const centerX = Math.abs(a.left + a.width / 2 - (b.left + b.width / 2));
      if (centerX < vDist) {
        result.snapPosition.x = b.left + b.width / 2 - a.width / 2;
        result.vertical = b.left + b.width / 2;
        vDist = centerX;
      }

      // --- horizontal guides (y alignment) ---
      const topTop = Math.abs(a.top - b.top);
      if (topTop < hDist) {
        result.snapPosition.y = b.top;
        result.horizontal = b.top;
        hDist = topTop;
      }
      const bottomTop = Math.abs(a.bottom - b.top);
      if (bottomTop < hDist) {
        result.snapPosition.y = b.top - a.height;
        result.horizontal = b.top;
        hDist = bottomTop;
      }
      const bottomBottom = Math.abs(a.bottom - b.bottom);
      if (bottomBottom < hDist) {
        result.snapPosition.y = b.bottom - a.height;
        result.horizontal = b.bottom;
        hDist = bottomBottom;
      }
      const topBottom = Math.abs(a.top - b.bottom);
      if (topBottom < hDist) {
        result.snapPosition.y = b.bottom;
        result.horizontal = b.bottom;
        hDist = topBottom;
      }
      // center-y alignment
      const centerY = Math.abs(a.top + a.height / 2 - (b.top + b.height / 2));
      if (centerY < hDist) {
        result.snapPosition.y = b.top + b.height / 2 - a.height / 2;
        result.horizontal = b.top + b.height / 2;
        hDist = centerY;
      }

      return result;
    }, defaultResult);
}

const canvasStyle: CSSProperties = {
  width: "100%",
  height: "100%",
  position: "absolute",
  top: 0,
  left: 0,
  pointerEvents: "none",
  zIndex: 10,
};

/** Draws the active alignment guides over the flow, transformed to screen space. */
export function HelperLines({
  horizontal,
  vertical,
}: {
  horizontal?: number;
  vertical?: number;
}) {
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);
  const tx = useStore((s) => s.transform[0]);
  const ty = useStore((s) => s.transform[1]);
  const zoom = useStore((s) => s.transform[2]);
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpi = window.devicePixelRatio || 1;
    canvas.width = width * dpi;
    canvas.height = height * dpi;
    ctx.scale(dpi, dpi);
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = "#2563eb";
    ctx.lineWidth = 1;

    if (typeof vertical === "number") {
      const x = vertical * zoom + tx;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    if (typeof horizontal === "number") {
      const y = horizontal * zoom + ty;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
  }, [width, height, tx, ty, zoom, horizontal, vertical]);

  return <canvas ref={ref} style={canvasStyle} />;
}
