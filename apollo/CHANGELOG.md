# apollo

## 0.3.1

### Patch Changes

- caa1c94: fix: people search hits the new `/mixed_people/api_search` endpoint after Apollo deprecated `/mixed_people/search`. Handles preview-only response shape (obfuscated last names, `total_entries` at the top level).
