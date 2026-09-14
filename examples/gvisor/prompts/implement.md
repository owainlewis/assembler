# Fix the slug generator

The project in /workspace contains a broken CommonJS `slugify(text)` function.
Make it turn ASCII titles into URL slugs: lowercase, replace each run of
non-alphanumeric characters with one hyphen, and remove leading/trailing hyphens.
An empty or punctuation-only title must produce an empty string.

Inspect the code, implement the fix, and run `node --test /checks/slugify.test.cjs`.
Keep the existing module export. Do not modify the tests or install dependencies.
Work only in /workspace. Finish with a short explanation of the change.
