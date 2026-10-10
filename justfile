home_dir := if env_var_or_default('HOME', '') != '' { env_var('HOME') } else { env_var('USERPROFILE') }

build:
    npm run build

format:
    npx prettier --write "src/**/*.ts"

lint:
    npx tsc --noEmit
    npx prettier --check "src/**/*.ts"

test:
    npm test

run *args:
    npm start -- {{args}}

install: build
    @mkdir -p ~/.local/bin
    @echo '#!/usr/bin/env bash' > {{home_dir}}/.local/bin/grey
    @echo 'exec node "'`pwd`'/dist/grey.mjs" "$@"' >> {{home_dir}}/.local/bin/grey
    @chmod +x {{home_dir}}/.local/bin/grey
