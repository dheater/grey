build:

format:
    stylua lua tests

lint:
    selene lua tests

test:
    nvim --headless -u NONE -l tests/run.lua

install:
