export interface ActionCapabilityMap {
  has(type: string): boolean;
  requiredCapabilitiesFor(type: string): string[];
}

export class StaticActionCapabilityMap implements ActionCapabilityMap {
  private readonly requiredCapabilitiesByType = new Map<string, string[]>();

  constructor(registrations: { type: string; requiredCapabilities?: readonly string[] }[]) {
    for (const registration of registrations) {
      if (this.requiredCapabilitiesByType.has(registration.type)) {
        throw new Error(`Action capability registration for type "${registration.type}" is already registered`);
      }
      this.requiredCapabilitiesByType.set(registration.type, [...(registration.requiredCapabilities ?? [])]);
    }
  }

  has(type: string): boolean {
    return this.requiredCapabilitiesByType.has(type);
  }

  requiredCapabilitiesFor(type: string): string[] {
    return [...(this.requiredCapabilitiesByType.get(type) ?? [])];
  }
}
