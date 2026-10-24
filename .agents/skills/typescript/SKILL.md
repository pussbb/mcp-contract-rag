---
name: typescript
description: TypeScript conventions for this repo (strict ESM, NodeNext, tsx runner, Babel AST typing). Load when writing or editing any .ts file or tsconfig.
---

# TypeScript in this repo

- Strict mode is on (`tsconfig.json`). No implicit `any`; type every function parameter and exported return type.
- ESM with `module: NodeNext`: relative imports **must use the `.js` extension** (`import { config } from '../config.js'`), even though the file is `.ts`. `tsx` resolves them at runtime.
- Use `import type` for type-only imports.
- Run files with `yarn tsx <file>`; typecheck with `yarn typecheck` (`tsc`, `noEmit`). Run the typecheck before declaring work done.
- `catch (err)` is `unknown`: narrow it (`err instanceof Error`) before reading `.message`.
- Babel AST nodes in `src/parser/extract.ts` are typed loosely as `AstNode = Record<string, any>` because the extractor duck-types over many node shapes. Keep that `any` contained there; exported functions return the precise `Analysis` / `ExtractedExport` types.
- Config is a zod schema in `src/config.ts`; derive types with `z.infer`, do not hand-write a parallel interface.
- Prefer `interface` for exported object shapes and string-literal unions over enums.
- Do not add runtime dependencies for type-only needs; use `@types/*` dev dependencies.

For deeper type-system work (generics, conditional and mapped types) also load `typescript-advanced-types`.

Docs: `docs/architecture.md` for the data contracts, `docs/configuration.md` for the config schema.
