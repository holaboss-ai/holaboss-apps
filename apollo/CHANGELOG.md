# apollo

## 0.3.2

### Patch Changes

- deeced5: fix: web UI redesigned with shadcn primitives (hairline-divider activity feed, header connection Badge, Notion-style smart timestamps) and `__root.tsx` migrated to the current TanStack Start root API so the SSR HTML actually emits the stylesheet link.

## 0.3.1

### Patch Changes

- caa1c94: fix: people search hits the new `/mixed_people/api_search` endpoint after Apollo deprecated `/mixed_people/search`. Handles preview-only response shape (obfuscated last names, `total_entries` at the top level).
