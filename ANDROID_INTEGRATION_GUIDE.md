# Android App Integration Guide for Loan Manager Backend

This document provides complete instructions and Kotlin / Retrofit code examples for integrating the **Loan Manager REST API** into your Android application.

---

## 1. Security & Validation Architecture

Every protected endpoint crosses a mandatory **4-layer validation pipeline**:
1. **Session Validation**: Active session stored in server MySQL `loan_sessions` table.
2. **Cookie Validation**: Session cookie (`connect.sid`) or auth cookies sent with request.
3. **CSRF Token Validation**: `x-csrf-token` header matching the issued token.
4. **JWT Authorization & Authentication**: Valid `Authorization: Bearer <token>` header.
5. **Cross-Check Verification**: User ID encoded inside the JWT payload must match the User ID inside the active session.

> **Security Failure Logging**: If any request fails any of the above checks, the full request details (IP address, client type, HTTP method, URL, headers, query, params, body, and exact failure reason) are automatically persisted into the `loan_security_logs` table in MySQL.

---

## 2. Authentication Flow for Android

```
[Android App] ---> GET  /api/auth/csrf    ---> [Backend returns CSRF token & sets cookie]
[Android App] ---> POST /api/auth/login   ---> [Backend sets Session cookie + returns JWT + CSRF]
[Android App] ---> (Stores JWT, CSRF, and preserves Cookies in CookieJar)
[Android App] ---> GET  /api/dashboard/summary (with CookieJar + Bearer Token + X-CSRF-Token)
```

---

## 3. OkHttp & Retrofit Setup (Kotlin)

### Step 1: Add Dependencies (`build.gradle.kts`)
```kotlin
implementation("com.squareup.retrofit2:retrofit:2.11.0")
implementation("com.squareup.retrofit2:converter-gson:2.11.0")
implementation("com.squareup.okhttp3:okhttp:4.12.0")
implementation("com.squareup.okhttp3:okhttp-urlconnection:4.12.0")
implementation("com.squareup.okhttp3:logging-interceptor:4.12.0")
```

### Step 2: CookieJar & Token Interceptor
```kotlin
package com.example.loanmanager.network

import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Response
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import java.util.concurrent.ConcurrentHashMap

// In-memory or SharedPreferences CookieJar
class PersistentCookieJar : CookieJar {
    private val cookieStore = ConcurrentHashMap<String, MutableList<Cookie>>()

    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        val host = url.host
        val current = cookieStore[host] ?: mutableListOf()
        current.addAll(cookies)
        cookieStore[host] = current
    }

    override fun loadForRequest(url: HttpUrl): List<Cookie> {
        return cookieStore[url.host] ?: emptyList()
    }

    fun clear() {
        cookieStore.clear()
    }
}

// Session, JWT & CSRF Interceptor
class LoanManagerAuthInterceptor : Interceptor {
    var jwtToken: String? = null
    var csrfToken: String? = null
    var sessionId: String? = null

    override fun intercept(chain: Interceptor.Chain): Response {
        val original = chain.request()
        val builder = original.newBuilder()

        // 1. Inform backend this is an Android client
        builder.header("x-client-platform", "Android App")
        builder.header("Accept", "application/json")

        // 2. Attach JWT Bearer Token if present
        jwtToken?.let {
            builder.header("Authorization", "Bearer $it")
        }

        // 3. Attach CSRF token header if present
        csrfToken?.let {
            builder.header("x-csrf-token", it)
            builder.header("x-xsrf-token", it)
        }

        // 4. Attach Session ID header if present (works with or without CookieJar)
        sessionId?.let {
            builder.header("x-session-id", it)
        }

        return chain.proceed(builder.build())
    }
}

// Retrofit Client Builder
object NetworkClient {
    // For Android Emulator use "http://10.0.2.2:5000/api/"
    // For Physical Device use your machine's LAN IP e.g. "http://192.168.1.X:5000/api/"
    private const val BASE_URL = "http://10.0.2.2:5000/api/"

    val cookieJar = PersistentCookieJar()
    val authInterceptor = LoanManagerAuthInterceptor()

    val okHttpClient = OkHttpClient.Builder()
        .cookieJar(cookieJar)
        .addInterceptor(authInterceptor)
        .build()

    val retrofit: Retrofit = Retrofit.Builder()
        .baseUrl(BASE_URL)
        .client(okHttpClient)
        .addConverterFactory(GsonConverterFactory.create())
        .build()

    val apiService: LoanApiService = retrofit.create(LoanApiService::class.java)
}
```

### Step 3: Retrofit API Interface
```kotlin
package com.example.loanmanager.network

import retrofit2.http.*

interface LoanApiService {
    // 1. Fetch Initial CSRF token
    @GET("auth/csrf")
    suspend fun getCsrf(): CsrfResponse

    // 2. Login
    @POST("auth/login")
    suspend fun login(@Body req: LoginRequest): LoginResponse

    // 3. Dashboard summary (who owes me, who I owe, today spent & received)
    @GET("dashboard/summary")
    suspend fun getDashboardSummary(): DashboardResponse

    // 4. Loans CRUD
    @GET("loans")
    suspend fun getLoans(
        @Query("type") type: String? = null,
        @Query("status") status: String? = null,
        @Query("search") search: String? = null
    ): LoanListResponse

    @POST("loans")
    suspend fun createLoan(@Body loan: CreateLoanRequest): ApiResponse

    @POST("loans/{id}/payments")
    suspend fun addPayment(
        @Path("id") loanId: Int,
        @Body payment: AddPaymentRequest
    ): ApiResponse
}
```

### Step 4: Login & Configure Interceptor
```kotlin
suspend fun performLogin(username: String, password: String) {
    try {
        // Step A: Fetch CSRF token
        val csrfRes = NetworkClient.apiService.getCsrf()
        NetworkClient.authInterceptor.csrfToken = csrfRes.csrfToken

        // Step B: Authenticate
        val loginRes = NetworkClient.apiService.login(LoginRequest(username, password))
        if (loginRes.success) {
            // Save token and updated csrfToken
            NetworkClient.authInterceptor.jwtToken = loginRes.token
            NetworkClient.authInterceptor.csrfToken = loginRes.csrfToken

            // All subsequent calls will now pass Session + Cookie + CSRF + JWT automatically!
            val dash = NetworkClient.apiService.getDashboardSummary()
            println("Pending Receivable: ${dash.data.metrics.pendingReceivable}")
            println("Today Spent: ${dash.data.metrics.todaySpent}")
            println("Today Received: ${dash.data.metrics.todayReceived}")
        }
    } catch (e: Exception) {
        e.printStackTrace()
    }
}
```

---

## 4. Primary API Endpoints Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/auth/csrf` | Get anti-CSRF token & set initial cookie |
| `POST` | `/api/auth/login` | Authenticate user, start session, get JWT |
| `POST` | `/api/auth/register` | Register new user account |
| `POST` | `/api/auth/logout` | Clear session & cookies |
| `GET` | `/api/dashboard/summary` | Today spent/received, pending receivable & payable |
| `GET` | `/api/loans` | Filter loans by person, date, status, location |
| `POST` | `/api/loans` | Record new loan (given or taken) |
| `POST` | `/api/loans/:id/payments` | Record repayment installment |
| `GET` | `/api/people` | People directory with net balance per person |
| `GET` | `/api/admin/users` | (Admin) View user accounts and pending totals |
| `GET` | `/api/admin/activity/monthly` | (Admin) View monthly platform activity |
| `GET` | `/api/admin/logs` | (Admin) Inspect security rejection logs |
