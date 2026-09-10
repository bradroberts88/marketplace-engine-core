export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      dealerships: {
        Row: {
          city: string | null
          contact_email: string | null
          created_at: string
          id: string
          monthly_price_cents: number
          name: string
          region: string | null
          slug: string
          status: string
          updated_at: string
        }
        Insert: {
          city?: string | null
          contact_email?: string | null
          created_at?: string
          id?: string
          monthly_price_cents?: number
          name: string
          region?: string | null
          slug: string
          status?: string
          updated_at?: string
        }
        Update: {
          city?: string | null
          contact_email?: string | null
          created_at?: string
          id?: string
          monthly_price_cents?: number
          name?: string
          region?: string | null
          slug?: string
          status?: string
          updated_at?: string
        }
        Relationships: []
      }
      device_events: {
        Row: {
          created_at: string
          dealership_id: string | null
          device_id: string
          event_type: string
          id: string
          message: string | null
          payload: Json
          severity: Database["public"]["Enums"]["event_severity"]
        }
        Insert: {
          created_at?: string
          dealership_id?: string | null
          device_id: string
          event_type: string
          id?: string
          message?: string | null
          payload?: Json
          severity?: Database["public"]["Enums"]["event_severity"]
        }
        Update: {
          created_at?: string
          dealership_id?: string | null
          device_id?: string
          event_type?: string
          id?: string
          message?: string | null
          payload?: Json
          severity?: Database["public"]["Enums"]["event_severity"]
        }
        Relationships: [
          {
            foreignKeyName: "device_events_dealership_id_fkey"
            columns: ["dealership_id"]
            isOneToOne: false
            referencedRelation: "dealerships"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "device_events_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "devices"
            referencedColumns: ["id"]
          },
        ]
      }
      devices: {
        Row: {
          agent_version: string | null
          claimed_at: string | null
          created_at: string
          dealership_id: string | null
          device_token_hash: string | null
          id: string
          image_version: string | null
          kind: Database["public"]["Enums"]["device_kind"]
          label: string
          last_heartbeat_at: string | null
          latency_ms: number | null
          notes: string | null
          public_ip: string | null
          serial: string | null
          status: Database["public"]["Enums"]["device_status"]
          updated_at: string
        }
        Insert: {
          agent_version?: string | null
          claimed_at?: string | null
          created_at?: string
          dealership_id?: string | null
          device_token_hash?: string | null
          id?: string
          image_version?: string | null
          kind?: Database["public"]["Enums"]["device_kind"]
          label: string
          last_heartbeat_at?: string | null
          latency_ms?: number | null
          notes?: string | null
          public_ip?: string | null
          serial?: string | null
          status?: Database["public"]["Enums"]["device_status"]
          updated_at?: string
        }
        Update: {
          agent_version?: string | null
          claimed_at?: string | null
          created_at?: string
          dealership_id?: string | null
          device_token_hash?: string | null
          id?: string
          image_version?: string | null
          kind?: Database["public"]["Enums"]["device_kind"]
          label?: string
          last_heartbeat_at?: string | null
          latency_ms?: number | null
          notes?: string | null
          public_ip?: string | null
          serial?: string | null
          status?: Database["public"]["Enums"]["device_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "devices_dealership_id_fkey"
            columns: ["dealership_id"]
            isOneToOne: false
            referencedRelation: "dealerships"
            referencedColumns: ["id"]
          },
        ]
      }
      listings: {
        Row: {
          created_at: string
          currency: string
          dealership_id: string
          description: string | null
          device_id: string | null
          external_listing_id: string | null
          id: string
          last_error: string | null
          make: string | null
          mileage_km: number | null
          model: string | null
          model_year: number | null
          photo_urls: string[]
          posted_at: string | null
          price_cents: number
          sold_at: string | null
          status: Database["public"]["Enums"]["listing_status"]
          title: string
          updated_at: string
          vin: string | null
        }
        Insert: {
          created_at?: string
          currency?: string
          dealership_id: string
          description?: string | null
          device_id?: string | null
          external_listing_id?: string | null
          id?: string
          last_error?: string | null
          make?: string | null
          mileage_km?: number | null
          model?: string | null
          model_year?: number | null
          photo_urls?: string[]
          posted_at?: string | null
          price_cents?: number
          sold_at?: string | null
          status?: Database["public"]["Enums"]["listing_status"]
          title: string
          updated_at?: string
          vin?: string | null
        }
        Update: {
          created_at?: string
          currency?: string
          dealership_id?: string
          description?: string | null
          device_id?: string | null
          external_listing_id?: string | null
          id?: string
          last_error?: string | null
          make?: string | null
          mileage_km?: number | null
          model?: string | null
          model_year?: number | null
          photo_urls?: string[]
          posted_at?: string | null
          price_cents?: number
          sold_at?: string | null
          status?: Database["public"]["Enums"]["listing_status"]
          title?: string
          updated_at?: string
          vin?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "listings_dealership_id_fkey"
            columns: ["dealership_id"]
            isOneToOne: false
            referencedRelation: "dealerships"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "listings_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "devices"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          amount_cents: number
          created_at: string
          currency: string
          dealership_id: string
          due_at: string | null
          id: string
          method: string | null
          notes: string | null
          paid_at: string | null
          period_end: string | null
          period_start: string | null
          reference: string | null
          status: Database["public"]["Enums"]["payment_status"]
          updated_at: string
        }
        Insert: {
          amount_cents: number
          created_at?: string
          currency?: string
          dealership_id: string
          due_at?: string | null
          id?: string
          method?: string | null
          notes?: string | null
          paid_at?: string | null
          period_end?: string | null
          period_start?: string | null
          reference?: string | null
          status?: Database["public"]["Enums"]["payment_status"]
          updated_at?: string
        }
        Update: {
          amount_cents?: number
          created_at?: string
          currency?: string
          dealership_id?: string
          due_at?: string | null
          id?: string
          method?: string | null
          notes?: string | null
          paid_at?: string | null
          period_end?: string | null
          period_start?: string | null
          reference?: string | null
          status?: Database["public"]["Enums"]["payment_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_dealership_id_fkey"
            columns: ["dealership_id"]
            isOneToOne: false
            referencedRelation: "dealerships"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          dealership_id: string | null
          email: string | null
          full_name: string | null
          id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          dealership_id?: string | null
          email?: string | null
          full_name?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          dealership_id?: string | null
          email?: string | null
          full_name?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_dealership_id_fkey"
            columns: ["dealership_id"]
            isOneToOne: false
            referencedRelation: "dealerships"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      current_dealership_id: { Args: never; Returns: string }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "admin" | "staff"
      device_kind: "pi_zerow" | "pi4" | "windows"
      device_status: "unclaimed" | "claimed" | "online" | "offline" | "retired"
      event_severity: "info" | "warning" | "error"
      listing_status:
        | "draft"
        | "queued"
        | "posted"
        | "paused"
        | "sold"
        | "removed"
        | "failed"
      payment_status: "pending" | "paid" | "failed" | "refunded"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "staff"],
      device_kind: ["pi_zerow", "pi4", "windows"],
      device_status: ["unclaimed", "claimed", "online", "offline", "retired"],
      event_severity: ["info", "warning", "error"],
      listing_status: [
        "draft",
        "queued",
        "posted",
        "paused",
        "sold",
        "removed",
        "failed",
      ],
      payment_status: ["pending", "paid", "failed", "refunded"],
    },
  },
} as const
