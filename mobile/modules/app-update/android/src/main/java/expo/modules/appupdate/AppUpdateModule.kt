package expo.modules.appupdate

import android.content.Intent
import android.net.Uri
import android.os.Build
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.CompletableDeferred
import java.io.File

/** Downloads the app's own update through UpdateDownloadService, which shows it in the notifications. */
class AppUpdateModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AppUpdate")
    Events("onProgress")

    AsyncFunction("download") Coroutine { url: String, headers: Map<String, String>, target: String, title: String ->
      val context = appContext.reactContext ?: throw CodedException("ERR_NO_CONTEXT", "The app is not ready", null)
      val path = Uri.parse(target).path ?: throw CodedException("ERR_TARGET", "No such file path", null)
      val finished = CompletableDeferred<Unit>()
      val job = DownloadJob(url, headers, File(path), title, finished) { done, total ->
        sendEvent("onProgress", mapOf("done" to done.toDouble(), "total" to total.toDouble()))
      }
      if (!CurrentDownload.job.compareAndSet(null, job)) {
        throw CodedException("ERR_BUSY", "A download is already running", null)
      }
      try {
        val intent = Intent(context, UpdateDownloadService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
        finished.await()
      } catch (cancelled: DownloadCancelled) {
        throw CodedException("ERR_CANCELLED", "The download was cancelled", cancelled)
      } finally {
        CurrentDownload.job.compareAndSet(job, null)
      }
    }

    Function("cancel") {
      CurrentDownload.job.get()?.cancelled = true
    }
  }
}
