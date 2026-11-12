import type * as React from 'react';

// The design system's icon element (public/design/icons.js).
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'pom-icon': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        name?: string;
        size?: string | number;
        spin?: string;
        label?: string;
        stroke?: string | number;
        auto?: string;
      };
    }
  }
}

export {};
