"use client";

/**
 * 시안 A — staggered wave bar. A recharts <Bar shape> that draws a top-rounded
 * bar and hands the reveal to CSS: the `.wave-bar` class grows it from the
 * baseline with a per-index delay so the series ripples in left-to-right.
 * recharts' own bar animation is turned off wherever this shape is used
 * (isAnimationActive={false}); per-<Cell> fills pass through via the `fill`
 * prop recharts merges into the shape.
 */
export default function WaveBar(props: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    fill?: string;
    index?: number;
    radius?: number;
}) {
    const { x = 0, y = 0, width = 0, height = 0, fill, index = 0, radius = 4 } = props;
    if (height <= 0 || width <= 0) return null;
    const r = Math.min(radius, width / 2, height);
    // Top-rounded bar path (rounded top corners only, flat baseline).
    const d = `M${x},${y + height} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + width - r},${y} Q${x + width},${y} ${x + width},${y + r} L${x + width},${y + height} Z`;
    return (
        <path
            d={d}
            fill={fill}
            className="wave-bar"
            style={{ ["--wave-i" as string]: index }}
        />
    );
}
