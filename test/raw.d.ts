// Tells TypeScript that any import ending in ?raw returns a string.
// Vitest resolves these as the raw file content at build time.
// Without this declaration: TS error "cannot find module '...?raw'"

declare module "*.sql?raw" {
  const content: string;
  export default content;
}
