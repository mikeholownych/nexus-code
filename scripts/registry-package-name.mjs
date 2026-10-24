// Encode npm package names as a single registry URL path segment.
export function registryPackageName(name) {
  return name.replaceAll("/", "%2f");
}
