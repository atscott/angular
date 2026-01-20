# Build packages
echo "Building packages..."
pnpm bazel build //packages/compiler:npm_package //packages/compiler-cli:npm_package


# Copy built packages to node_modules
echo "Copying Angular packages to node_modules..."
# Ensure destination directories exist, fix permissions first if they exist
mkdir -p test-dump-app/node_modules/@angular

if [ -d "test-dump-app/node_modules/@angular/compiler" ]; then
    chmod -R +w test-dump-app/node_modules/@angular/compiler
    rm -rf test-dump-app/node_modules/@angular/compiler
fi
if [ -d "test-dump-app/node_modules/@angular/compiler-cli" ]; then
    chmod -R +w test-dump-app/node_modules/@angular/compiler-cli
    rm -rf test-dump-app/node_modules/@angular/compiler-cli
fi

cp -R dist/bin/packages/compiler/npm_package test-dump-app/node_modules/@angular/compiler
cp -R dist/bin/packages/compiler-cli/npm_package test-dump-app/node_modules/@angular/compiler-cli

# Run the binary
echo "Running ng-dump-sources..."
cd test-dump-app
rm -rf output
# Ensure we map the bin correctly if needed, or just run node
node node_modules/@angular/compiler-cli/bundles/src/bin/dump_sources.js -p tsconfig.json --dumpDir output

# Run tsgo to compile the output
echo "Compiling output with tsgo..."
../node_modules/.bin/tsgo -p tsconfig.output.json
