import { identifierBytes } from "./identifiers";
import { type CanonicalValue, canonicalMap, canonicalSet } from "./value";

export const DEPENDENCY_TYPES = {
  VaultRecord: 1,
  VaultBaseline: 2,
  VaultObject: 3,
  BundleDescriptorObject: 4,
  ArtifactObject: 5,
  NoteContentObject: 6,
  KeyEnvelope: 7,
  FeatureManifest: 8,
} as const;

export type DependencyType = (typeof DEPENDENCY_TYPES)[keyof typeof DEPENDENCY_TYPES];

export interface TypedDependency {
  readonly type: DependencyType;
  readonly id: Uint8Array;
}

export function dependencyValue(dependency: TypedDependency): ReadonlyMap<number, CanonicalValue> {
  if (!Object.values(DEPENDENCY_TYPES).includes(dependency.type)) {
    throw new TypeError("Unknown dependency type");
  }
  const id = identifierBytes("Dependency ID", dependency.id);
  return canonicalMap([
    [0, dependency.type],
    [1, id],
  ]);
}

export function dependencySet(
  dependencies: readonly TypedDependency[],
): readonly ReadonlyMap<number, CanonicalValue>[] {
  return canonicalSet(dependencies.map(dependencyValue));
}
