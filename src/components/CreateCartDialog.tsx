'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { Cart } from '@/lib/types'

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  onCreated: (cart: Cart) => void
}

export function CreateCartDialog({ open, onOpenChange, onCreated }: Props) {
  const [name, setName] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!name.trim()) return
    setLoading(true)
    try {
      const res = await fetch('/api/cart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setName('')
      onCreated(data)
    } catch (err) {
      toast.error('Failed to create stack: ' + (err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Create a new stack</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            placeholder="e.g. Summer reading list"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <Button type="submit" className="w-full" disabled={loading || !name.trim()}>
            {loading ? 'Creating…' : 'Create Stack'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}
