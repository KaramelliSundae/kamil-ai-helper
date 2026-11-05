import { AlertDialog, Text, TextButton } from '@expo/ui/jetpack-compose';

/** Asks once more before something that cannot be taken back with a tap. */
export function ConfirmDialog({ title, text, confirm, onConfirm, onCancel }: {
  title: string;
  text: string;
  confirm: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <AlertDialog onDismissRequest={onCancel}>
      <AlertDialog.Title>
        <Text>{title}</Text>
      </AlertDialog.Title>
      <AlertDialog.Text>
        <Text>{text}</Text>
      </AlertDialog.Text>
      <AlertDialog.ConfirmButton>
        <TextButton onClick={onConfirm}>
          <Text>{confirm}</Text>
        </TextButton>
      </AlertDialog.ConfirmButton>
      <AlertDialog.DismissButton>
        <TextButton onClick={onCancel}>
          <Text>Vazgeç</Text>
        </TextButton>
      </AlertDialog.DismissButton>
    </AlertDialog>
  );
}
