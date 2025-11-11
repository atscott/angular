# Environment settings

- I use nvm for managing node versions. You will likely need to use `source ~/.nvm/nvm.sh`.
- When running Angular tests with the angular cli (`ng test`), you should use `--watch=false` to ensure the command returns control to you
- Tests in the Angular repos (angular, angular-cli, components, etc.) use bazel. Run these with the local bazel version using `pnpm bazel test <test_target>`
