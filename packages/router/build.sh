#!/bin/bash
set -ex

# This script is used for building the @angular/router package locally
# so that it can be consumed by a test project
# Usage: ./build.sh /path/to/test-project

readonly bazel_bin=$(yarn run -s bazel info workspace)/dist/bin
# readonly bazel_bin=$(yarn run -s bazel info bazel-bin)
readonly test_repo="$1"

if [[ -z "${test_repo}" ]]; then
  echo "Please provide path to the project repo"
  exit 1
fi

yarn bazel build --config=release //packages/router:npm_package
pushd "${test_repo}"
cp -r "${bazel_bin}/packages/router/npm_package" node_modules/@angular/router
popd
