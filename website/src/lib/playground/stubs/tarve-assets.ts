// Native asset embedding is a desktop build concern; the browser resolves asset paths as URLs.
export function nativeAssetPath(path: string): string {
  return path;
}

export default {};
