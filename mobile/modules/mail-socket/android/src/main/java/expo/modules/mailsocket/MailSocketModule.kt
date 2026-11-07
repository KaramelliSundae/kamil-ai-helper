package expo.modules.mailsocket

import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** School mail through Eclipse Angus Mail: see AngusMail.kt. Everything runs off the shared module thread, so a slow server holds up nothing else. */
class MailSocketModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("MailSocket")

    AsyncFunction("countInbox") Coroutine { account: MailAccount ->
      withContext(Dispatchers.IO) { countInbox(account) }
    }

    AsyncFunction("readMail") Coroutine { request: ReadRequest ->
      withContext(Dispatchers.IO) { readMail(request) }
    }

    AsyncFunction("sendMail") Coroutine { mail: OutgoingMail ->
      withContext(Dispatchers.IO) { sendMail(mail) }
    }
  }
}
