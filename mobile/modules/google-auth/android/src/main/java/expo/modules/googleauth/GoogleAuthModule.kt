package expo.modules.googleauth

import android.app.Activity
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.ClearTokenRequest
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.common.api.CommonStatusCodes
import com.google.android.gms.common.api.Scope
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val REQUEST = 41_07

/**
 * Asks Android for a short-lived access token to one Google scope. Google recognises the app by its package name and
 * signing certificate, so there is no client secret here and no long-lived token to keep. Only that token reaches
 * JavaScript. It lasts an hour, and asking again later needs no screen as long as the permission stands.
 */
class GoogleAuthModule : Module() {
  private var waiting: Promise? = null

  private fun failure(error: Exception): CodedException {
    val status = (error as? ApiException)?.statusCode
    return when (status) {
      CommonStatusCodes.DEVELOPER_ERROR -> CodedException("ERR_GOOGLE_CLIENT", "This build has no Google client", error)
      CommonStatusCodes.CANCELED -> CodedException("ERR_GOOGLE_CANCELLED", "Cancelled", error)
      CommonStatusCodes.NETWORK_ERROR -> CodedException("ERR_GOOGLE_NETWORK", "No connection", error)
      else -> CodedException("ERR_GOOGLE", "Google refused: ${status ?: "unknown"}", error)
    }
  }

  override fun definition() = ModuleDefinition {
    Name("GoogleAuth")

    AsyncFunction("authorize") { scope: String, promise: Promise ->
      val activity: Activity = appContext.activityProvider?.currentActivity
        ?: throw CodedException("ERR_GOOGLE", "The app is not on screen", null)
      if (waiting != null) throw CodedException("ERR_GOOGLE_BUSY", "Already asking", null)
      val request = AuthorizationRequest.builder().setRequestedScopes(listOf(Scope(scope))).build()
      Identity.getAuthorizationClient(activity).authorize(request)
        .addOnSuccessListener { result ->
          val consent = result.pendingIntent
          if (result.hasResolution() && consent != null) {
            waiting = promise
            try {
              activity.startIntentSenderForResult(consent.intentSender, REQUEST, null, 0, 0, 0)
            } catch (error: Exception) {
              waiting = null
              promise.reject(CodedException("ERR_GOOGLE", "Could not open the permission screen", error))
            }
          } else {
            promise.resolve(result.accessToken)
          }
        }
        .addOnFailureListener { error -> promise.reject(failure(error)) }
    }

    AsyncFunction("clearToken") { token: String, promise: Promise ->
      val activity: Activity = appContext.activityProvider?.currentActivity
        ?: throw CodedException("ERR_GOOGLE", "The app is not on screen", null)
      Identity.getAuthorizationClient(activity)
        .clearToken(ClearTokenRequest.builder().setToken(token).build())
        .addOnSuccessListener { promise.resolve(null) }
        .addOnFailureListener { promise.resolve(null) }
    }

    OnActivityResult { activity, payload ->
      if (payload.requestCode != REQUEST) return@OnActivityResult
      val promise = waiting ?: return@OnActivityResult
      waiting = null
      try {
        promise.resolve(Identity.getAuthorizationClient(activity).getAuthorizationResultFromIntent(payload.data).accessToken)
      } catch (error: ApiException) {
        promise.reject(failure(error))
      }
    }
  }
}
