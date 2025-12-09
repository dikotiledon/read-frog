export function migrate(oldConfig: any): any {
  const translate = oldConfig?.translate ?? {}
  const useGenAIBatching = typeof translate.useGenAIBatching === 'boolean'
    ? translate.useGenAIBatching
    : true

  return {
    ...oldConfig,
    translate: {
      ...translate,
      useGenAIBatching,
    },
  }
}
