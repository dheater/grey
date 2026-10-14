build:

format:
    stylua

lint:
    selene tests

test:
    nvim --headless -u NONE -l tests/run.lua

install:
