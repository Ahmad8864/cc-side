import type { Permission } from './protocol.ts'

export type Question = { question: string; options: { label: string; description?: string }[]; multiSelect: boolean }
export function questionsFor(permission: Permission): Question[] {
  if (permission.tool !== 'AskUserQuestion' || !Array.isArray(permission.input.questions)) return []
  return permission.input.questions.flatMap((q: unknown) => {
    if (!q || typeof q !== 'object' || !('question' in q) || typeof q.question !== 'string') return []
    const options = 'options' in q && Array.isArray(q.options) ? q.options.flatMap((o: unknown) => {
      if (!o || typeof o !== 'object' || !('label' in o) || typeof o.label !== 'string') return []
      return [{ label: o.label, ...('description' in o && typeof o.description === 'string' ? { description: o.description } : {}) }]
    }) : []
    return [{ question: q.question, options, multiSelect: 'multiSelect' in q && q.multiSelect === true }]
  })
}
