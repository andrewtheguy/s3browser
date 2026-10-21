import type * as React from "react"
import { Toaster as Sonner } from "sonner"

type ToasterProps = React.ComponentProps<typeof Sonner>

// Sonner's own stylesheet is unlayered and beats Tailwind utilities, so theme it
// through the CSS variables it reads instead of classNames.
const toasterStyle = {
  "--normal-bg": "var(--popover)",
  "--normal-text": "var(--popover-foreground)",
  "--normal-border": "var(--border)",
  "--success-bg": "var(--popover)",
  "--success-text": "var(--success)",
  "--success-border": "color-mix(in srgb, var(--success) 35%, var(--border))",
  "--error-bg": "var(--popover)",
  "--error-text": "var(--destructive)",
  "--error-border": "color-mix(in srgb, var(--destructive) 35%, var(--border))",
  "--warning-bg": "var(--popover)",
  "--warning-text": "var(--warning)",
  "--warning-border": "color-mix(in srgb, var(--warning) 35%, var(--border))",
  "--info-bg": "var(--popover)",
  "--info-text": "var(--info)",
  "--info-border": "color-mix(in srgb, var(--info) 35%, var(--border))",
  "--border-radius": "var(--radius)",
  fontFamily: "var(--font-sans)",
} as React.CSSProperties

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      className="toaster group"
      position="top-right"
      closeButton
      richColors
      style={toasterStyle}
      {...props}
    />
  )
}

export { Toaster }
