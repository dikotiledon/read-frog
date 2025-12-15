import { Entity } from 'dexie'

export default class PerfSample extends Entity {
  key!: string
  label!: string
  stage!: string
  deltaMs!: number
  totalMs!: number
  surface?: string | null
  mode?: string | null
  url?: string | null
  createdAt!: Date
}
