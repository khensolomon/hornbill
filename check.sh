#!/usr/bin/env bash
# Syntax-check every JS file as an ES module.
#
# `node --check FILE` treats a bare .js as CommonJS and does NOT validate
# module syntax — it returns 0 on files with real errors (e.g. a `try` with
# no `catch`). Feeding the file on stdin with --input-type=module is the
# check that actually parses these files the way GJS does.
set -u
cd "$(dirname "$0")" || exit 1

fail=0
while IFS= read -r f; do
    if ! err=$(node --input-type=module --check < "$f" 2>&1); then
        echo "FAIL $f"
        echo "$err" | sed -n '1,6p' | sed 's/^/     /'
        fail=1
    fi
done < <(find . -name '*.js' -not -path './tmp/*' | sort)

if [ "$fail" -eq 0 ]; then
    echo "All modules parse cleanly."
fi
exit "$fail"
