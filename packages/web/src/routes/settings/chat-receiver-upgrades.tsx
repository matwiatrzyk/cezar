import { Button } from '@/components/ui/button'

export type ChatReceiverUpgrade = { id: string; name: string; expectedRevision: string }
export function ChatReceiverUpgrades({ receivers, states, available, onUpgrade }: {
 receivers: readonly { id: string; name: string; chatId?: string }[]
 states: readonly { receiverId: string; inboundRevision: string }[]
 available: boolean
 onUpgrade: (receiver: ChatReceiverUpgrade) => void
}) {
 const hooks = receivers.filter(receiver => !receiver.chatId)
 if (!hooks.length) return null
 return <div className="flex flex-col gap-3">
  <p className="text-ui text-muted-foreground">Connect a bot to an existing notification receiver to add task control. Its notification settings are kept.</p>
  {hooks.map(receiver => {
   const revision = states.find(state => state.receiverId === receiver.id)?.inboundRevision
   return <div key={receiver.id} className="flex items-center justify-between gap-3 rounded border p-3">
    <span>{receiver.name}</span>
    <Button variant="outline" aria-label={`Add task control to ${receiver.name}`} disabled={!available || !revision}
     onClick={() => { if (available && revision) onUpgrade({ id: receiver.id, name: receiver.name, expectedRevision: revision }) }}>Add task control</Button>
   </div>
  })}
 </div>
}
