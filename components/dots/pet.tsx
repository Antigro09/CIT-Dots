"use client";

import { useId } from "react";
import type { Dot } from "@/src/shared/types";

export type PetMood = "idle" | "working" | "question";

/** Original vector companion, drawn and animated locally; no image service required. */
export function PetAvatar({
  dot,
  mood = "idle",
  className = "",
}: {
  dot: Pick<Dot, "name" | "avatar">;
  mood?: PetMood;
  className?: string;
}) {
  const id = useId().replaceAll(":", "");
  const { kind, color } = dot.avatar;
  const robot = kind === "robot";
  return (
    <svg
      viewBox="0 0 220 190"
      role="img"
      aria-label={`${dot.name}, your ${kind} Dot companion`}
      className={`pet-avatar pet-${kind} pet-${mood} ${className}`}
    >
      <defs>
        <linearGradient id={`pet-shade-${id}`} x1=".2" y1="0" x2=".75" y2="1">
          <stop offset="0" stopColor={color} />
          <stop offset="1" stopColor={color} stopOpacity=".78" />
        </linearGradient>
      </defs>
      <ellipse
        className="pet-shadow"
        cx="110"
        cy="170"
        rx="48"
        ry="8"
        fill="currentColor"
        opacity=".12"
      />
      <g className="pet-body">
        {kind === "cat" ? (
          <>
            <path d="M49 74 48 23 Q49 17 55 23L86 51Z" fill={color} />
            <path d="m136 51 29-28q7-6 7 2l-1 50Z" fill={color} />
            <path d="m55 59-1-25 20 23Z" fill="#fff" opacity=".24" />
            <path d="m149 56 16-22-1 25Z" fill="#fff" opacity=".24" />
          </>
        ) : null}
        {kind === "dog" ? (
          <>
            <ellipse
              cx="48"
              cy="78"
              rx="20"
              ry="39"
              transform="rotate(16 48 78)"
              fill={color}
            />
            <ellipse
              cx="173"
              cy="78"
              rx="20"
              ry="39"
              transform="rotate(-16 173 78)"
              fill={color}
            />
            <ellipse
              cx="45"
              cy="83"
              rx="10"
              ry="25"
              transform="rotate(16 45 83)"
              fill="#172920"
              opacity=".14"
            />
            <ellipse
              cx="176"
              cy="83"
              rx="10"
              ry="25"
              transform="rotate(-16 176 83)"
              fill="#172920"
              opacity=".14"
            />
          </>
        ) : null}
        {robot ? (
          <>
            <path
              d="M110 42V24"
              stroke={color}
              strokeWidth="7"
              strokeLinecap="round"
            />
            <circle cx="110" cy="18" r="8" fill={color} />
            <rect x="31" y="79" width="16" height="32" rx="6" fill={color} />
            <rect x="173" y="79" width="16" height="32" rx="6" fill={color} />
          </>
        ) : null}
        {robot ? (
          <rect
            x="43"
            y="42"
            width="134"
            height="115"
            rx="34"
            fill={`url(#pet-shade-${id})`}
          />
        ) : (
          <path
            d="M41 107C35 76 49 47 78 43c13-20 44-20 60 0 29 3 44 31 40 59 3 31-20 56-55 57H91c-31 0-56-20-50-52Z"
            fill={`url(#pet-shade-${id})`}
          />
        )}
        <ellipse cx="76" cy="154" rx="20" ry="12" fill={color} />
        <ellipse cx="144" cy="154" rx="20" ry="12" fill={color} />
        <path
          d="M60 68c5-9 13-14 23-14"
          stroke="#fff"
          strokeOpacity=".35"
          strokeWidth="6"
          strokeLinecap="round"
          fill="none"
        />
        {robot ? (
          <rect
            x="59"
            y="69"
            width="102"
            height="61"
            rx="18"
            fill="#172920"
            opacity=".84"
          />
        ) : null}
        <g className="pet-face">
          <g className="pet-eyes" fill={robot ? color : "#23382a"}>
            <ellipse
              className="pet-eye"
              cx="84"
              cy="93"
              rx={robot ? "6" : "5"}
              ry="9"
            />
            <ellipse
              className="pet-eye"
              cx="137"
              cy="93"
              rx={robot ? "6" : "5"}
              ry="9"
            />
          </g>
          {kind === "dog" ? (
            <>
              <ellipse
                cx="110"
                cy="119"
                rx="23"
                ry="17"
                fill="#fff"
                opacity=".35"
              />
              <path d="m104 112 6 6 6-6q-6-6-12 0Z" fill="#23382a" />
              <path
                d="M110 119v6"
                stroke="#23382a"
                strokeWidth="2.5"
                strokeLinecap="round"
              />
            </>
          ) : (
            <path
              d="M101 115q9 10 18 0"
              fill="none"
              stroke={robot ? color : "#23382a"}
              strokeWidth="3"
              strokeLinecap="round"
            />
          )}
          {!robot ? (
            <>
              <ellipse
                cx="66"
                cy="108"
                rx="9"
                ry="5"
                fill="#fff"
                opacity=".24"
              />
              <ellipse
                cx="156"
                cy="108"
                rx="9"
                ry="5"
                fill="#fff"
                opacity=".24"
              />
            </>
          ) : null}
          {kind === "cat" ? (
            <g
              stroke="#23382a"
              strokeOpacity=".35"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <path d="m52 113 15 3m-15 7 15-1m87-7 15-3m-15 10 15 1" />
            </g>
          ) : null}
        </g>
      </g>
    </svg>
  );
}
