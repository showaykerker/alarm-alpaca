import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { LoaderCircle } from "lucide-react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  // active:scale + transition-all makes finger-taps visibly register on the
  // touchscreen, where there is no hover or haptic cue. transition-all on a
  // button is cheap and gives the colour/transform both a single duration.
  "relative inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-all duration-150 active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        // Sizes bumped ~20% on 2026-05-18 for the 5-inch panel — dialogs
        // and footer buttons felt small under thumb. sm stays for dense
        // layouts (table rows etc.) where the previous default lived.
        default: "h-14 px-6 py-2 text-lg",
        sm: "h-10 rounded-md px-3 text-sm",
        lg: "h-16 rounded-md px-7 text-xl",
        xl: "h-20 rounded-lg px-10 text-2xl",
        icon: "h-14 w-14",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  // When true the button is disabled, the existing label/icon is hidden but
  // still occupies space (so the width doesn't jump), and a spinner is laid
  // over the centre. Touchscreen flows often double-tap when there's no
  // feedback — making this an explicit prop lets every action site opt in
  // without each page reimplementing a spinner overlay.
  loading?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading = false, disabled, children, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    const isButton = !asChild;
    // Only forward `disabled` when we're rendering a real <button>; the Slot
    // path passes through to whatever child is supplied (e.g. an <a>) which
    // doesn't support the attribute.
    const disabledAttr = isButton ? { disabled: disabled || loading } : {};
    // Slot (asChild) forwards props onto its single child and rejects extra
    // siblings. Loading overlay only makes sense for real <button> renders
    // anyway — for asChild we just pass children through.
    if (asChild) {
      return (
        <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props}>
          {children}
        </Comp>
      );
    }
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        aria-busy={loading || undefined}
        {...disabledAttr}
        {...props}
      >
        {/* Wrapper preserves the natural width when loading: it stays in the
            flex flow (so the button keeps its size) but goes invisible while
            the absolutely-positioned spinner takes over the centre. The
            spinner is `absolute`, so the parent's `gap-2` does not push it
            away from the (invisible) label. */}
        <span className={cn("inline-flex items-center gap-2", loading && "opacity-0")}>
          {children}
        </span>
        {loading ? (
          <span
            className="absolute inset-0 flex items-center justify-center"
            aria-hidden="true"
          >
            <LoaderCircle className="h-5 w-5 animate-spin" />
          </span>
        ) : null}
      </Comp>
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
