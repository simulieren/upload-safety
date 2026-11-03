# upload-safety docs

The documentation site for [upload-safety](https://www.npmjs.com/package/upload-safety), built with [Starlight](https://starlight.astro.build/). It is a separate package so the library keeps zero dependencies; nothing here ships to npm.

```sh
cd docs
npm install
npm run dev      # http://localhost:4321
npm run build    # static site in docs/dist
```

Pages live in `src/content/docs/`.
