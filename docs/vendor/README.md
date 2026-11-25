tinfoil-1.4.0.js is the Tinfoil JS SDK (npm tinfoil@1.4.0), SecureClient only,
bundled so the page loads no third-party script. Rebuild:

    npm install tinfoil@1.4.0 esbuild@0.24
    echo 'export { SecureClient } from "tinfoil";' > entry.js
    npx esbuild entry.js --bundle --format=esm --platform=browser --target=es2022 \
      --minify --legal-comments=none --external:zlib --outfile=tinfoil-1.4.0.js

zlib is external because the SDK only imports it when DecompressionStream is
missing, which never happens in current browsers.
