import { ImageResponse } from "next/og";

export const size = {
  width: 32,
  height: 32,
};

export const contentType = "image/png";

// Favicon: the Hogsend bar-chart mark (ascending chocolate bars with a raspberry
// accent bar) on a vanilla canvas. Kept blocky so it stays crisp at 32px.
export default function Icon() {
  const bars: { height: number; color: string }[] = [
    { height: 9, color: "#3a2418" },
    { height: 14, color: "#3a2418" },
    { height: 19, color: "#e8688f" },
    { height: 24, color: "#3a2418" },
  ];

  return new ImageResponse(
    <div
      style={{
        height: "100%",
        width: "100%",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        gap: "3px",
        backgroundColor: "#fbf3e1",
        padding: "5px",
        borderRadius: "7px",
      }}
    >
      {bars.map((bar) => (
        <div
          key={bar.height}
          style={{
            width: "4px",
            height: `${bar.height}px`,
            borderRadius: "2px",
            backgroundColor: bar.color,
          }}
        />
      ))}
    </div>,
    size,
  );
}
