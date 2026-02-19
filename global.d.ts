interface Window {
  L: any;
  turf: any;
  JSZip: any;
  fs: {
    readFile: (path: string) => Promise<ArrayBuffer>;
  };
}
