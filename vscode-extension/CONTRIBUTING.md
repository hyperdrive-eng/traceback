## Development

### Setup

```sh
# Install dependencies
npm install

# Compile the extension
npm run compile

# Package the extension
npm run package
```

### Run Extension

1. Build extension

   ```sh
   npm install
   npm run compile
   ```

2. Open directory in VS Code or Cursor

   ```sh
   cursor .
   # or
   code .
   ```

3. Launch extension

   1. Press F5 to open a new window with your extension loaded
   2. If you make changes to your extension, restart the extension development host