import { redirect } from 'next/navigation';

// The clinic's own rules live in "Reminders and campaigns" → "Rules" now
export default function MyAutomationsPage() {
  redirect('/automations?view=rules');
}
